/**
 * Risk Pipeline orchestrator — the single code path every event flows through
 * (§3 diagram). Stages: Event -> Features -> Detector -> Score -> Agent ->
 * Guard -> Policy -> Action/Escalation -> Audit. Every stage is traced, every
 * failure escalates, everything is audited.
 *
 * Failure recovery (§15):
 *  - Detector throws/times out -> agent never called; escalate with
 *    failure_state "detector_unavailable".
 *  - LLM fails/times out -> MockProvider fallback; audit failure_state
 *    "llm_unavailable" (the fallback itself always escalates).
 *  - Action Executor timeout -> check downstream state; retry once; escalate.
 *  - Duplicate webhook -> idempotency returns cached result (webhook layer).
 */

import {
  AgentOutput,
  AnyDetectorResult,
  AuditRecord,
  ModuleName,
  PipelineResponse,
  PipelineStageTrace,
  PolicyResult,
} from '../types';
import { RiskManagerAgent } from '../agents/riskManagerAgent';
import { PolicyEngine } from '../policy';
import { RateLimiter, computeIdempotencyKey } from '../policy';
import { ActionExecutor, faultInjection } from '../execution';
import { AuditService } from '../audit';
import { extractWindowFeatures, WindowFeatures } from '../features';
import { detectFraudSpike, DEFAULT_FRAUD_SPIKE_CONFIG } from '../detectors/fraudSpike';
import { scoreReturnRisk } from '../detectors/returnRisk';
import { detectAbuseRing } from '../detectors/abuseRing';
import { assessChargeback } from '../detectors/chargeback';
import { Transaction, Order, LinkedAccount, Dispute } from '../types';
import { config } from '../config';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';

export type RiskEvent =
  | { module: 'fraud_spike'; merchant_id: string; window: Transaction[]; prior_window_features: WindowFeatures[]; window_start?: string; window_end?: string }
  | { module: 'return_risk'; merchant_id: string; order: Order }
  | { module: 'abuse_ring'; merchant_id: string; accounts: LinkedAccount[]; anchor_account_id: string }
  | { module: 'chargeback'; merchant_id: string; dispute: Dispute };

export interface PipelineDeps {
  agent: RiskManagerAgent;
  policy: PolicyEngine;
  rateLimiter: RateLimiter;
  executor: ActionExecutor;
  audit: AuditService;
}

export class RiskPipeline {
  constructor(private deps: PipelineDeps) {}

  /** Runs the full pipeline for one event. Never throws — failures escalate. */
  async process(event: RiskEvent, externalEventId?: string, opts?: { detectorTimeoutMs?: number }): Promise<PipelineResponse> {
    const eventId = externalEventId || `evt_${uuidv4()}`;
    const stages: PipelineStageTrace[] = [];
    const type = `${event.module}_event`;
    const policyVersion = this.deps.policy.getConfig().version;
    const detectorTimeoutMs = opts?.detectorTimeoutMs ?? config.detector_timeout_ms;

    // ---------------- Stage: detector ----------------
    let detectorOutput: AnyDetectorResult | null = null;
    let detectorFailed = false;

    const detectorStart = Date.now();
    try {
      detectorOutput = await withDetectorTimeout(this.runDetector(event), detectorTimeoutMs);
      stages.push({
        stage: 'detector',
        status: detectorOutput.failure_state ? 'failed' : 'ok',
        detail: detectorOutput.failure_state || `${detectorOutput.module} scored`,
        duration_ms: Date.now() - detectorStart,
      });
    } catch (err) {
      detectorFailed = true;
      logger.error({ err: (err as Error).message, module: event.module }, 'detector failure');
      stages.push({
        stage: 'detector',
        status: 'failed',
        detail: `detector timeout/failure: ${(err as Error).message}`,
        duration_ms: Date.now() - detectorStart,
      });
    }

    // ---------------- Stage: agent ----------------
    // §15: detector threw -> agent is never called.
    let agentOutput: AgentOutput;
    let guardInfo: { accepted: boolean; reason?: string } | undefined;
    let llmFailureState: string | undefined;

    if (detectorFailed) {
      const fallbackDetector = syntheticFailureDetector(event.module, event.merchant_id);
      agentOutput = this.deps.agent.deterministicEscalation(fallbackDetector, 'Detector unavailable (timeout or crash)');
      guardInfo = { accepted: true };
      llmFailureState = 'detector_unavailable';
      stages.push({ stage: 'agent', status: 'skipped', detail: 'detector failed — deterministic escalation, LLM never called' });
    } else if (detectorOutput!.failure_state) {
      agentOutput = this.deps.agent.deterministicEscalation(detectorOutput!, `Detector reported ${detectorOutput!.failure_state}`);
      guardInfo = { accepted: true };
      llmFailureState = detectorOutput!.failure_state || undefined;
      stages.push({ stage: 'agent', status: 'skipped', detail: `detector failure_state=${detectorOutput!.failure_state} — deterministic escalation` });
    } else {
      const agentStart = Date.now();
      const agentRun = await this.deps.agent.run(detectorOutput!, { event_id: eventId });
      agentOutput = agentRun.agent_output!;
      guardInfo = { accepted: agentRun.guard.accepted, reason: agentRun.guard.reason };
      if (agentRun.llm_used === 'mock' && this.usesRealLlm()) {
        llmFailureState = 'llm_unavailable';
      }
      if (agentRun.failure_state === 'agent_output_rejected') {
        llmFailureState = 'agent_output_rejected';
      }
      stages.push({
        stage: 'agent',
        status: agentRun.llm_used === 'none' ? 'skipped' : 'ok',
        detail: `provider=${agentRun.llm_used}${agentRun.failure_state ? `, guard_rejected=${agentRun.guard.reason}` : ''}`,
        duration_ms: Date.now() - agentStart,
      });
    }

    // ---------------- Stage: guard ----------------
    if (guardInfo && !guardInfo.accepted) {
      stages.push({ stage: 'guard', status: 'failed', detail: `rejected: ${guardInfo.reason}` });
    } else {
      stages.push({ stage: 'guard', status: 'ok', detail: guardInfo?.reason ? `rejected->escalation: ${guardInfo.reason}` : 'all checks passed' });
    }

    // ---------------- Stage: policy ----------------
    const policyInput = detectorOutput || syntheticFailureDetector(event.module, event.merchant_id);
    const policyResult: PolicyResult = this.deps.policy.evaluate(agentOutput, policyInput as AnyDetectorResult, {
      merchant_id: event.merchant_id,
    });
    stages.push({
      stage: 'policy',
      status: policyResult.decision === 'approved' ? 'ok' : 'failed',
      detail: `${policyResult.decision}: ${policyResult.reason}`,
    });

    // ---------------- Stage: execution / escalation ----------------
    let execution: PipelineResponse['execution'];
    let escalation: PipelineResponse['escalation'];
    let executionResultDetail = '';
    // Same key the Action Executor resolves — recorded in the audit trail so a
    // replay/escalation can always be tied back to its idempotency entry.
    const idempotencyKey = computeIdempotencyKey({
      merchant_id: event.merchant_id,
      module: event.module,
      event_id: eventId,
      action: agentOutput.recommended_action,
    });

    const guardRejected = guardInfo ? !guardInfo.accepted : false;

    if (policyResult.decision === 'approved' && !guardRejected && !agentOutput.escalate_to_human && !llmFailureState) {
      const execStart = Date.now();
      const execResult = await this.deps.executor.execute({
        merchant_id: event.merchant_id,
        module: event.module,
        event_id: eventId,
        action: agentOutput.recommended_action,
      });
      execution = {
        status: execResult.status,
        action: execResult.action,
        detail: execResult.detail,
        idempotent_replay: execResult.idempotent_replay,
      };
      executionResultDetail = execResult.status;
      stages.push({
        stage: 'execution',
        status: execResult.status === 'escalated' ? 'failed' : 'ok',
        detail: `${execResult.status} (attempts: ${execResult.attempts})`,
        duration_ms: Date.now() - execStart,
      });
      if (execResult.status === 'escalated') {
        escalation = { required: true, reason: 'action_executor_failed_twice' };
      }
      if (execResult.status === 'executed') {
        this.deps.rateLimiter.record(event.merchant_id, event.module);
      }
    } else {
      const reason =
        llmFailureState === 'detector_unavailable'
          ? 'detector_unavailable'
          : guardRejected
            ? `agent_output_rejected: ${guardInfo!.reason}`
            : llmFailureState === 'agent_output_rejected'
              ? `agent_output_rejected: ${guardInfo?.reason}`
              : llmFailureState === 'llm_unavailable'
                ? 'llm_unavailable — conservative fallback escalated'
                : agentOutput.escalate_to_human
                  ? 'agent requested escalation'
                  : policyResult.reason;
      escalation = { required: true, reason };
      executionResultDetail = 'escalated';
      stages.push({ stage: 'escalation', status: 'ok', detail: reason });
    }

    // ---------------- Stage: audit ----------------
    let auditRecord: AuditRecord | null = null;
    try {
      auditRecord = await this.deps.audit.log({
        merchant_id: event.merchant_id,
        module: event.module,
        detector: detectorName(event.module),
        detector_version: detectorOutput?.detector_version,
        policy_version: policyVersion,
        input_reference: inputReference(event),
        event_id: eventId,
        detector_output: detectorOutput || { error: 'detector_failed' },
        recommended_action: agentOutput.recommended_action,
        policy_decision: policyResult.decision,
        policy_reason: policyResult.reason,
        human_escalation: escalation?.required ?? agentOutput.escalate_to_human,
        confidence: agentOutput.confidence,
        evidence_cited: agentOutput.evidence_cited,
        execution_result: executionResultDetail,
        failure_state: llmFailureState || undefined,
        guard_rejection_reason: guardInfo?.reason,
        idempotency_key: idempotencyKey,
      });
      stages.push({ stage: 'audit', status: 'ok', detail: `recorded (${auditRecord.hash.slice(0, 12)}…)` });
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'audit write failed');
      stages.push({ stage: 'audit', status: 'failed', detail: (err as Error).message });
    }

    return {
      type,
      merchant_id: event.merchant_id,
      event_id: eventId,
      stages,
      detector: detectorOutput || undefined,
      agent: agentOutput,
      guard: guardInfo,
      policy: policyResult,
      execution,
      escalation,
      audit_id: auditRecord?.id,
      audit_hash: auditRecord?.hash,
    };
  }

  private async runDetector(event: RiskEvent): Promise<AnyDetectorResult> {
    switch (event.module) {
      case 'fraud_spike': {
        if (faultInjection.detector_timeout) {
          // Real fault path: hang until the pipeline timeout fires. A
          // never-resolving promise (no timer) avoids leaking handles.
          await new Promise<never>(() => {});
        }
        return detectFraudSpike({
          merchant_id: event.merchant_id,
          current_window: event.window,
          prior_window_features: event.prior_window_features,
          window_start: event.window_start,
          window_end: event.window_end,
        });
      }
      case 'return_risk':
        return scoreReturnRisk(event.order);
      case 'abuse_ring':
        return detectAbuseRing(event.merchant_id, event.accounts, event.anchor_account_id);
      case 'chargeback':
        return assessChargeback(event.dispute);
    }
  }

  private usesRealLlm(): boolean {
    return config.llm_provider === 'gemini' && !!config.gemini_api_key;
  }
}

function withDetectorTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`detector timeout after ${ms}ms`)), ms)),
  ]);
}

function syntheticFailureDetector(module: ModuleName, merchantId: string): AnyDetectorResult {
  return {
    module,
    detector_version: 'unavailable',
    merchant_id: merchantId,
    calibrated_probability: 0,
    confidence: 'low',
    failure_state: 'detector_unavailable',
    ...(module === 'fraud_spike'
      ? { is_spike: false, anomaly_score: 0, affected_transaction_ids: [], affected_transactions_value: 0, baseline: { mean: 0, std: 0, window_type: '10m', sample_windows: 0, trailing_counts: [] } }
      : {}),
    ...(module === 'return_risk' ? { top_risk_factors: [], similar_past_orders: [] } : {}),
    ...(module === 'abuse_ring'
      ? { ring_score: 0, cluster_id: 'cluster_none', cluster_size: 0, connecting_signals: [], member_account_ids: [], edge_density: 0 }
      : {}),
    ...(module === 'chargeback'
      ? { win_probability: 0, missing_evidence_types: [], reason_code_base_rate: 0, evidence_completeness: 0, days_until_deadline: 0 }
      : {}),
  } as AnyDetectorResult;
}

function detectorName(module: ModuleName): string {
  switch (module) {
    case 'fraud_spike':
      return 'fraudSpikeDetector';
    case 'return_risk':
      return 'returnRiskDetector';
    case 'abuse_ring':
      return 'abuseRingDetector';
    case 'chargeback':
      return 'chargebackAssessor';
  }
}

function inputReference(event: RiskEvent): string {
  switch (event.module) {
    case 'fraud_spike':
      return `window_${event.window_start || 'na'}`;
    case 'return_risk':
      return event.order.order_id;
    case 'abuse_ring':
      return event.anchor_account_id;
    case 'chargeback':
      return event.dispute.dispute_id;
  }
}
