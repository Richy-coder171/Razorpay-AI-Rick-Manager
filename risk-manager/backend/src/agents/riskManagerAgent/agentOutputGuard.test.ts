/**
 * Agent Output Guard tests (§12, §23) — SAFETY-CRITICAL CORE.
 * Deliberately adversarial: sneak a wrong score, an invented transaction id,
 * and an out-of-enum action past the guard. ALL MUST BE CAUGHT.
 */

import { validateAgentOutput } from './agentOutputGuard';
import { FraudSpikeResult, AgentOutput, MODULE_ACTION_ALLOWLIST } from '../../types';

const detector: FraudSpikeResult = {
  module: 'fraud_spike',
  detector_version: 'fraud-spike-v2',
  merchant_id: 'merchant_001',
  is_spike: true,
  anomaly_score: 4.2,
  calibrated_probability: 0.87,
  confidence: 'high',
  affected_transaction_ids: ['pay_001', 'pay_002', 'pay_003'],
  affected_transactions_value: 45000,
  baseline: { mean: 110, std: 12, window_type: '10m', sample_windows: 30 },
};

function validOutput(): AgentOutput {
  return {
    module: 'fraud_spike',
    tool_called: 'score_fraud_spike',
    calibrated_probability: 0.87,
    recommended_action: 'auto_block_window',
    confidence: 'high',
    escalate_to_human: false,
    explanation: 'Probability 0.87 with high confidence over 30 baseline windows.',
    evidence_cited: ['calibrated_probability', 'affected_transaction_ids', 'pay_001', 'baseline.mean'],
  };
}

describe('Agent Output Guard (safety-critical)', () => {
  it('accepts a fully valid output', () => {
    const result = validateAgentOutput(validOutput(), detector);
    expect(result.accepted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('REJECTS a wrong score (score_mismatch)', () => {
    const bad = { ...validOutput(), calibrated_probability: 0.99 };
    const result = validateAgentOutput(bad, detector);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('score_mismatch');
  });

  it('REJECTS a subtle 2-decimal score drift', () => {
    const bad = { ...validOutput(), calibrated_probability: 0.88 };
    const result = validateAgentOutput(bad, detector);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('score_mismatch');
  });

  it('REJECTS a changed confidence (confidence_mismatch)', () => {
    const bad = { ...validOutput(), confidence: 'medium' as const };
    const result = validateAgentOutput(bad, detector);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('confidence_mismatch');
  });

  it('REJECTS an invented transaction id (fabricated_evidence)', () => {
    const bad = { ...validOutput(), evidence_cited: ['pay_001', 'pay_INVENTED_999'] };
    const result = validateAgentOutput(bad, detector);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('fabricated_evidence');
    expect(result.detail).toContain('pay_INVENTED_999');
  });

  it('REJECTS an out-of-enum action (disallowed_action)', () => {
    const bad = { ...validOutput(), recommended_action: 'ban_account_forever' };
    const result = validateAgentOutput(bad, detector);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('disallowed_action');
  });

  it('REJECTS a "ban" action hallucinated by the LLM (defense-only invariant)', () => {
    const bad = { ...validOutput(), recommended_action: 'permanent_ban' };
    const result = validateAgentOutput(bad, detector);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('disallowed_action');
    expect(MODULE_ACTION_ALLOWLIST.abuse_ring).not.toContain('ban');
  });

  it('REJECTS schema-invalid output (missing fields, wrong types)', () => {
    const bad = { module: 'fraud_spike', recommended_action: 'no_action' }; // missing most fields
    const result = validateAgentOutput(bad, detector);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('schema_invalid');
  });

  it('REJECTS a cross-module action (return_risk action on fraud_spike module)', () => {
    const bad = { ...validOutput(), recommended_action: 'require_prepaid' };
    const result = validateAgentOutput(bad, detector);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('disallowed_action');
  });

  it('accepts null probability only when the detector also produced none', () => {
    const failedDetector = { ...detector, calibrated_probability: 0, failure_state: 'insufficient_data' as const };
    const out = { ...validOutput(), calibrated_probability: null as unknown as number };
    const result = validateAgentOutput(out, failedDetector);
    expect(result.accepted).toBe(false); // 0 !== null — mismatch
  });

  it('collects evidence ids from the actual detector output only', () => {
    const bad = { ...validOutput(), evidence_cited: ['made_up_field.subfield'] };
    const result = validateAgentOutput(bad, detector);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('fabricated_evidence');
  });
});
