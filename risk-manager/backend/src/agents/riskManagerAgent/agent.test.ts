/**
 * Risk Manager Agent tests (§11, §23).
 */

import { RiskManagerAgent } from './agent';
import { MockProvider } from './provider';
import { FraudSpikeResult } from '../../types';

const spikeDetector: FraudSpikeResult = {
  module: 'fraud_spike',
  detector_version: 'fraud-spike-v2',
  merchant_id: 'merchant_001',
  is_spike: true,
  anomaly_score: 4.4,
  calibrated_probability: 0.92,
  confidence: 'high',
  affected_transaction_ids: ['pay_001', 'pay_002'],
  affected_transactions_value: 90000,
  baseline: { mean: 100, std: 10, window_type: '10m', sample_windows: 35 },
};

const normalDetector: FraudSpikeResult = {
  module: 'fraud_spike',
  detector_version: 'fraud-spike-v2',
  merchant_id: 'merchant_001',
  is_spike: false,
  anomaly_score: 0.4,
  calibrated_probability: 0.08,
  confidence: 'high',
  affected_transaction_ids: ['pay_001'],
  affected_transactions_value: 500,
  baseline: { mean: 100, std: 10, window_type: '10m', sample_windows: 35 },
};

describe('Risk Manager Agent', () => {
  it('routes a valid high-probability spike through guard successfully (mock provider)', async () => {
    const agent = new RiskManagerAgent(new MockProvider());
    const result = await agent.run(spikeDetector);
    expect(result.llm_used).toBe('mock');
    expect(result.guard.accepted).toBe(true);
    expect(result.agent_output).not.toBeNull();
    expect(result.agent_output!.calibrated_probability).toBe(0.92);
    expect(result.agent_output!.confidence).toBe('high');
  });

  it('never calls the LLM when the detector reports a failure_state', async () => {
    const agent = new RiskManagerAgent(new MockProvider());
    const failed = { ...spikeDetector, failure_state: 'insufficient_data' as const };
    const result = await agent.run(failed);
    expect(result.llm_used).toBe('none');
    expect(result.agent_output!.escalate_to_human).toBe(true);
    expect(result.failure_state).toBe('insufficient_data');
  });

  it('falls back to deterministic escalation when the LLM provider throws', async () => {
    const brokenProvider = {
      name: 'openrouter',
      complete: async () => {
        throw new Error('api key invalid');
      },
    };
    const agent = new RiskManagerAgent(brokenProvider as never);
    const result = await agent.run(normalDetector);
    // Broken openrouter -> mock fallback -> conservative output that escalates.
    expect(result.llm_used).toBe('mock');
    expect(result.agent_output!.escalate_to_human).toBe(true);
    expect(result.guard.accepted).toBe(true);
  });

  it('rejects unparseable LLM output with agent_output_rejected', async () => {
    const gabber = { name: 'openrouter', complete: async () => 'I am not JSON at all' };
    const agent = new RiskManagerAgent(gabber as never);
    const result = await agent.run(normalDetector);
    expect(result.failure_state).toBe('agent_output_rejected');
    expect(result.agent_output!.escalate_to_human).toBe(true);
  });

  it('deterministic escalation copies the detector probability without inventing one', async () => {
    const agent = new RiskManagerAgent(new MockProvider());
    const out = agent.deterministicEscalation(spikeDetector, 'test');
    expect(out.calibrated_probability).toBe(0.92);
    expect(out.escalate_to_human).toBe(true);
  });
});
