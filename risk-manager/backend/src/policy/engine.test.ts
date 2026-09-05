/**
 * Policy Engine tests (§13, §23) — SAFETY-CRITICAL CORE.
 * All nine precedence branches + the one-directional invariant.
 */

import { PolicyEngine, loadPolicyConfig } from './engine';
import { AgentOutput, FraudSpikeResult, ChargebackResult } from '../types';

const config = loadPolicyConfig();

const detector: FraudSpikeResult = {
  module: 'fraud_spike',
  detector_version: 'fraud-spike-v2',
  merchant_id: 'merchant_001',
  is_spike: true,
  anomaly_score: 4.2,
  calibrated_probability: 0.95,
  confidence: 'high',
  affected_transaction_ids: ['pay_001'],
  affected_transactions_value: 45000,
  baseline: { mean: 110, std: 12, window_type: '10m', sample_windows: 30 },
};

function output(overrides: Partial<AgentOutput> = {}): AgentOutput {
  return {
    module: 'fraud_spike',
    tool_called: 'score_fraud_spike',
    calibrated_probability: 0.95,
    recommended_action: 'flag_for_review',
    confidence: 'high',
    escalate_to_human: true,
    explanation: 'high probability spike',
    evidence_cited: ['calibrated_probability'],
    ...overrides,
  };
}

function engine(count = 0) {
  return new PolicyEngine(structuredClone(config), { getAutoActionCount: () => count });
}

describe('Policy Engine (safety-critical)', () => {
  it('approves a reversible action with high confidence outside the band', () => {
    const result = engine().evaluate(output({ recommended_action: 'flag_for_review' }), detector, { merchant_id: 'merchant_001' });
    // flag_for_review is reversible and p=0.95 outside band; approved
    expect(result.decision).toBe('approved');
  });

  it('check 1: escalates when the global kill switch is ON', () => {
    const e = engine();
    e.setGlobalKillSwitch(true);
    const result = e.evaluate(output(), detector, { merchant_id: 'merchant_001' });
    expect(result.decision).toBe('escalated');
    expect(result.reason).toBe('global_kill_switch_active');
  });

  it('check 2: escalates on detector failure_state', () => {
    const failed = { ...detector, failure_state: 'detector_unavailable' as const };
    const result = engine().evaluate(output(), failed, { merchant_id: 'merchant_001' });
    expect(result.decision).toBe('escalated');
    expect(result.reason).toBe('detector_failure_state');
  });

  it('check 3: escalates when confidence is below required', () => {
    const result = engine().evaluate(output({ confidence: 'medium' }), detector, { merchant_id: 'merchant_001' });
    expect(result.decision).toBe('escalated');
    expect(result.reason).toBe('confidence_below_required');
  });

  it('check 4: escalates when probability is inside the escalation band [0.40, 0.60]', () => {
    const mid = output({ calibrated_probability: 0.5 });
    const midDetector = { ...detector, calibrated_probability: 0.5 };
    const result = engine().evaluate(mid, midDetector, { merchant_id: 'merchant_001' });
    expect(result.decision).toBe('escalated');
    expect(result.reason).toBe('probability_inside_escalation_band');
  });

  it('check 4 boundary: 0.40 and 0.60 are both inside the band', () => {
    for (const p of [0.4, 0.6]) {
      const result = engine().evaluate(output({ calibrated_probability: p }), { ...detector, calibrated_probability: p }, { merchant_id: 'm' });
      expect(result.reason).toBe('probability_inside_escalation_band');
    }
  });

  it('check 5: escalates when the action is not in the module allowlist', () => {
    const result = engine().evaluate(output({ recommended_action: 'ban_everyone' }), detector, { merchant_id: 'merchant_001' });
    expect(result.decision).toBe('escalated');
    expect(result.reason).toBe('action_not_in_allowlist');
  });

  it('check 6: escalates when irreversible action is below the auto threshold', () => {
    const result = engine().evaluate(output({ recommended_action: 'auto_block_window', calibrated_probability: 0.8 }), { ...detector, calibrated_probability: 0.8 }, { merchant_id: 'merchant_001' });
    expect(result.decision).toBe('escalated');
    expect(result.reason).toBe('irreversible_action_below_threshold');
  });

  it('check 6: approves irreversible action at/above threshold with high confidence', () => {
    const result = engine().evaluate(output({ recommended_action: 'auto_block_window', calibrated_probability: 0.93 }), { ...detector, calibrated_probability: 0.93 }, { merchant_id: 'merchant_001' });
    expect(result.decision).toBe('approved');
  });

  it('check 7: escalates when the per-merchant rate limit is exceeded', () => {
    const e = engine(5); // already at the limit
    const result = e.evaluate(output(), detector, { merchant_id: 'merchant_001' });
    expect(result.decision).toBe('escalated');
    expect(result.reason).toBe('per_merchant_rate_limit_exceeded');
  });

  it('check 8: escalates when required chargeback evidence is missing', () => {
    const dispute: ChargebackResult = {
      module: 'chargeback',
      detector_version: 'chargeback-v1',
      merchant_id: 'merchant_001',
      win_probability: 0.85,
      calibrated_probability: 0.85,
      confidence: 'high',
      missing_evidence_types: ['proof_of_delivery'],
      reason_code_base_rate: 0.46,
      evidence_completeness: 0.33,
      days_until_deadline: 5,
      failure_state: null,
    };
    const e = new PolicyEngine(structuredClone(config), {
      getAutoActionCount: () => 0,
      getMissingEvidence: (d) => (d as ChargebackResult).missing_evidence_types,
    });
    const result = e.evaluate(
      output({ module: 'chargeback', recommended_action: 'auto_contest_full', calibrated_probability: 0.95 }),
      { ...dispute, calibrated_probability: 0.95 },
      { merchant_id: 'merchant_001' }
    );
    expect(result.decision).toBe('escalated');
    expect(result.reason).toBe('required_evidence_missing');
  });

  it('one-directional: never turns an escalation into an approval', () => {
    const e = engine();
    e.setGlobalKillSwitch(true);
    const escalated = e.evaluate(output(), detector, { merchant_id: 'merchant_001' });
    expect(escalated.approved).toBe(false);
    expect(PolicyEngine.oneDirectionalInvariant(escalated)).toBe(true);
  });

  it('runs checks in documented precedence order (kill switch beats everything)', () => {
    const e = engine();
    e.setGlobalKillSwitch(true);
    const result = e.evaluate(output({ confidence: 'low', recommended_action: 'ban_all' }), detector, { merchant_id: 'm' });
    expect(result.reason).toBe('global_kill_switch_active');
    expect(result.checks_run[0].check).toBe('global_kill_switch');
  });

  it('records every check with pass/fail detail for auditability', () => {
    const result = engine().evaluate(output(), detector, { merchant_id: 'merchant_001' });
    const names = result.checks_run.map((c) => c.check);
    expect(names).toContain('global_kill_switch');
    expect(names).toContain('require_confidence');
    expect(names).toContain('escalation_band');
    expect(names).toContain('action_allowlist');
    expect(names).toContain('irreversible_action_threshold');
    expect(names).toContain('rate_limit');
  });
});
