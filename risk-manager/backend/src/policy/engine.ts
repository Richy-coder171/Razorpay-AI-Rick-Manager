/**
 * Policy Engine v2 (§13) — config-driven (policy.config.json), pure and
 * unit-testable. Decision precedence (ANY escalation condition is sufficient):
 *
 *  1. global_kill_switch on                          -> escalate
 *  2. detector failure_state set                     -> escalate
 *  3. confidence !== require_confidence               -> escalate
 *  4. probability inside escalation_band              -> escalate
 *  5. action not in module allowed_actions           -> escalate
 *  6. action irreversible && probability < threshold  -> escalate
 *  7. per-merchant rate limit exceeded               -> escalate
 *  8. required evidence missing (chargeback)         -> escalate
 *  9. otherwise                                      -> approve
 *
 * One-directional: the Policy Engine can turn a recommendation into an
 * escalation; it can NEVER turn an escalation into an automatic approval.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  AgentOutput,
  AnyDetectorResult,
  PolicyConfig,
  PolicyModuleConfig,
  PolicyResult,
  ModuleName,
} from '../types';

export function loadPolicyConfig(file?: string): PolicyConfig {
  const configFile = file || path.resolve(__dirname, 'policy.config.json');
  const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8')) as PolicyConfig;
  if (!parsed.version || !parsed.modules) {
    throw new Error(`Malformed policy config: ${configFile}`);
  }
  return parsed;
}

export interface PolicyEngineDependencies {
  /** auto-action count for merchant+module in the trailing hour */
  getAutoActionCount: (merchantId: string, module: ModuleName) => number;
  /** missing required evidence for chargeback disputes */
  getMissingEvidence?: (detectorOutput: AnyDetectorResult) => string[];
}

export class PolicyEngine {
  private config: PolicyConfig;

  constructor(config?: PolicyConfig, private deps?: PolicyEngineDependencies) {
    this.config = config || loadPolicyConfig();
  }

  getConfig(): PolicyConfig {
    return this.config;
  }

  setGlobalKillSwitch(on: boolean): void {
    this.config.global_kill_switch = on;
  }

  /** Pure decision function: AgentOutput + DetectorOutput -> PolicyResult. */
  evaluate(
    agentOutput: AgentOutput,
    detectorOutput: AnyDetectorResult,
    ctx: { merchant_id: string }
  ): PolicyResult {
    const module = agentOutput.module as ModuleName;
    const moduleConfig = this.config.modules[module];
    const checks: PolicyResult['checks_run'] = [];

    // 1. Global kill switch
    const killSwitchOn = this.config.global_kill_switch;
    checks.push({ check: 'global_kill_switch', passed: !killSwitchOn, detail: killSwitchOn ? 'ON' : 'off' });
    if (killSwitchOn) return escalate('global_kill_switch_active', checks);

    // 2. Detector failure state
    const detectorFailed = !!detectorOutput.failure_state;
    checks.push({ check: 'detector_failure_state', passed: !detectorFailed, detail: detectorOutput.failure_state || 'none' });
    if (detectorFailed) return escalate('detector_failure_state', checks);

    // 3. Confidence requirement
    const confidenceOk = agentOutput.confidence === moduleConfig.require_confidence;
    checks.push({
      check: 'require_confidence',
      passed: confidenceOk,
      detail: `agent=${agentOutput.confidence}, required=${moduleConfig.require_confidence}`,
    });
    if (!confidenceOk) return escalate('confidence_below_required', checks);

    // 4. Escalation band (only when detector produced a probability)
    const probability = agentOutput.calibrated_probability;
    if (probability !== null && typeof probability === 'number') {
      const [lo, hi] = moduleConfig.escalation_band;
      const inBand = probability >= lo && probability <= hi;
      checks.push({
        check: 'escalation_band',
        passed: !inBand,
        detail: `p=${probability}, band=[${lo}, ${hi}]`,
      });
      if (inBand) return escalate('probability_inside_escalation_band', checks);
    }

    // 5. Action allowlist
    const actionAllowed = moduleConfig.allowed_actions.includes(agentOutput.recommended_action);
    checks.push({
      check: 'action_allowlist',
      passed: actionAllowed,
      detail: `"${agentOutput.recommended_action}" in [${moduleConfig.allowed_actions.join(', ')}]`,
    });
    if (!actionAllowed) return escalate('action_not_in_allowlist', checks);

    // 6. Irreversible action threshold
    const isIrreversible = moduleConfig.irreversible_actions.includes(agentOutput.recommended_action);
    const thresholdOk = !isIrreversible || (probability !== null && probability >= moduleConfig.auto_action_threshold);
    checks.push({
      check: 'irreversible_action_threshold',
      passed: thresholdOk,
      detail: isIrreversible
        ? `irreversible; p=${probability}, needs >= ${moduleConfig.auto_action_threshold}`
        : 'action is reversible',
    });
    if (!thresholdOk) return escalate('irreversible_action_below_threshold', checks);

    // 7. Per-merchant rate limit (auto actions per hour)
    const currentCount = this.deps?.getAutoActionCount(ctx.merchant_id, module) ?? 0;
    const rateOk = currentCount < moduleConfig.max_auto_actions_per_merchant_per_hour;
    checks.push({
      check: 'rate_limit',
      passed: rateOk,
      detail: `${currentCount}/${moduleConfig.max_auto_actions_per_merchant_per_hour} auto actions this hour`,
    });
    if (!rateOk) return escalate('per_merchant_rate_limit_exceeded', checks);

    // 8. Required evidence (chargeback)
    if (module === 'chargeback' && this.deps?.getMissingEvidence) {
      const missing = this.deps.getMissingEvidence(detectorOutput);
      const evidenceOk = missing.length === 0;
      checks.push({
        check: 'required_evidence',
        passed: evidenceOk,
        detail: missing.length === 0 ? 'all present' : `missing: ${missing.join(', ')}`,
      });
      if (!evidenceOk) return escalate('required_evidence_missing', checks);
    }

    // 9. All checks passed -> approve
    checks.push({ check: 'all_checks_passed', passed: true });
    return {
      decision: 'approved',
      approved: true,
      reason: 'all_checks_passed',
      checks_run: checks,
    };
  }

  /**
   * Post-guard re-check used when the pipeline re-evaluates an escalated
   * recommendation: escalation can never be turned into approval here.
   */
  static oneDirectionalInvariant(result: PolicyResult): boolean {
    return !(result.decision === 'approved' && result.reason.includes('escalat'));
  }
}

function escalate(reason: string, checks: PolicyResult['checks_run']): PolicyResult {
  return { decision: 'escalated', approved: false, reason, checks_run: checks };
}
