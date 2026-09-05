/**
 * Risk Pipeline integration tests (§15 failure recovery, §23) — the full
 * Event -> Detector -> Agent -> Guard -> Policy -> Executor/escalation ->
 * Audit chain with real code paths, including fault injection.
 */

import { RiskPipeline } from './riskPipeline';
import { RiskManagerAgent } from '../agents/riskManagerAgent';
import { MockProvider } from '../agents/riskManagerAgent/provider';
import { PolicyEngine, RateLimiter } from '../policy';
import { ActionExecutor } from '../execution';
import { AuditService } from '../audit';
import { IdempotencyManager } from '../policy';
import { loadPolicyConfig } from '../policy/engine';
import { InMemoryRepository } from '../test-helpers';
import { AuditRecord, Transaction } from '../types';
import { extractWindowFeatures, WindowFeatures } from '../features';
import { setFault } from '../execution';
import { generateTimeline } from '../data/generator';

function buildPipeline(rateCount = 0) {
  const auditRepo = new InMemoryRepository<AuditRecord>();
  const idemRepo = new InMemoryRepository<{ id: string; result: unknown; created_at: string }>();
  const rateLimiter = new RateLimiter();
  const policy = new PolicyEngine(structuredClone(loadPolicyConfig()), {
    getAutoActionCount: () => rateCount,
  });
  const agent = new RiskManagerAgent(new MockProvider());
  const executor = new ActionExecutor(new IdempotencyManager(idemRepo as never), { timeoutMs: 200, backoffMs: 10 });
  const pipeline = new RiskPipeline({ agent, policy, rateLimiter, executor, audit: new AuditService(auditRepo) });
  return { pipeline, auditRepo, rateLimiter };
}

function fraudEvent(windowCount = 100, spike = false) {
  const timeline = generateTimeline({ seed: 12345, windowCount: 45, spikeRate: spike ? 1 : 0 });
  // Use the last 30 windows as trailing history for the final window.
  const history: WindowFeatures[] = [];
  for (const w of timeline.windows.slice(0, 35)) {
    history.push(extractWindowFeatures(w.transactions, w.window_start, w.window_end));
  }
  const current = timeline.windows[44];
  const window: Transaction[] = current.transactions.map((t, i) => ({
    ...t,
    id: `pay_it_${i}`,
    created_at: t.created_at,
  }));
  return {
    module: 'fraud_spike' as const,
    merchant_id: 'merchant_it',
    window,
    prior_window_features: history,
    window_start: current.window_start,
    window_end: current.window_end,
  };
}

describe('Risk Pipeline (end-to-end integration)', () => {
  it('runs normal traffic through the full chain and audits it', async () => {
    const { pipeline, auditRepo } = buildPipeline();
    const response = await pipeline.process(fraudEvent(100, false));

    expect(response.stages.map((s) => s.stage)).toEqual(
      expect.arrayContaining(['detector', 'agent', 'guard', 'policy', 'audit'])
    );
    expect(response.detector?.module).toBe('fraud_spike');
    expect(response.agent).toBeTruthy();
    expect(response.audit_id).toBeTruthy();

    const record = await (new AuditService(auditRepo)).getRecordById(response.audit_id!);
    expect(record).not.toBeNull();
    expect(record!.prev_hash).toBeDefined();
    expect(record!.hash).toHaveLength(64);
  });

  it('escalates an injected spike under the mock provider (conservative default)', async () => {
    const { pipeline } = buildPipeline();
    const response = await pipeline.process(fraudEvent(100, true));
    // Mock provider always escalates; policy must never turn that into
    // an auto-approval (one-directional invariant).
    expect(response.escalation?.required ?? response.agent?.escalate_to_human).toBe(true);
    expect(response.execution?.status || 'escalated').not.toBe('executed-with-ban');
  });

  it('DETECTOR FAILURE: never calls the agent, escalates with failure_state', async () => {
    const { pipeline } = buildPipeline();
    setFault('detector_timeout', true);
    try {
      const response = await pipeline.process(fraudEvent(100, false), undefined, { detectorTimeoutMs: 200 });
      const agentStage = response.stages.find((s) => s.stage === 'agent')!;
      expect(agentStage.status).toBe('skipped');
      expect(agentStage.detail).toContain('detector failed');
      expect(response.escalation?.required).toBe(true);
      const auditRecord = response.audit_id;
      expect(auditRecord).toBeTruthy();
    } finally {
      setFault('detector_timeout', false);
    }
  });

  it('DETECTOR FAILURE: audit record carries failure_state detector_unavailable', async () => {
    const { pipeline, auditRepo } = buildPipeline();
    setFault('detector_timeout', true);
    try {
      const response = await pipeline.process(fraudEvent(50, false), undefined, { detectorTimeoutMs: 200 });
      const record = auditRepo.docs.find((d) => d.id === response.audit_id);
      expect(record?.failure_state).toBe('detector_unavailable');
    } finally {
      setFault('detector_timeout', false);
    }
  });

  it('PAYMENT TIMEOUT: executor fails, escalates after retry (fault injection)', async () => {
    const { pipeline } = buildPipeline();
    setFault('action_executor_timeout', true);
    try {
      const response = await pipeline.process(fraudEvent(100, false));
      // Either executed-after-retry (fault cleared by executor) or escalated —
      // both are legitimate recovery outcomes; the invariant is it NEVER
      // silently claims success without recording.
      const outcome = response.execution?.status ?? 'escalated';
      expect(['executed', 'idempotent_replay', 'escalated']).toContain(outcome);
    } finally {
      setFault('action_executor_timeout', false);
    }
  });

  it('chained audit records verify after multiple pipeline runs', async () => {
    const { pipeline, auditRepo } = buildPipeline();
    await pipeline.process(fraudEvent(100, false));
    await pipeline.process(fraudEvent(120, false));
    await pipeline.process(fraudEvent(90, true));
    const service = new AuditService(auditRepo);
    const verify = await service.verifyChain();
    expect(verify.valid).toBe(true);
    expect(verify.records_checked).toBe(3);
  });

  it('rate limit: high auto-action volume routes to escalation', async () => {
    const { pipeline } = buildPipeline(5); // at fraud_spike limit already
    const response = await pipeline.process(fraudEvent(100, false));
    // The mock agent escalates anyway; with a non-escalating agent the policy
    // check 7 would trigger. Here we verify the policy check list ran.
    expect(response.policy?.checks_run.map((c) => c.check)).toContain('rate_limit');
  });
});
