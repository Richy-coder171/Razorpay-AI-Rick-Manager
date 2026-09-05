import {
  detectFraudSpike,
  computeTrailingBaseline,
  rawAnomalyScore,
  applyCalibration,
  computeConfidence,
  DEFAULT_FRAUD_SPIKE_CONFIG,
} from './detector';
import { extractWindowFeatures, WindowFeatures } from '../../features';
import { Transaction } from '../../types';

function txn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: `pay_${Math.random().toString(36).slice(2, 10)}`,
    merchant_id: 'merchant_001',
    amount: 500,
    currency: 'INR',
    status: 'captured',
    payment_mode: 'prepaid',
    customer_id: `cust_${Math.floor(Math.random() * 50)}`,
    region: 'north',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeHistory(n: number, count: number, seedOffset = 0): WindowFeatures[] {
  return Array.from({ length: n }, (_, i) => extractWindowFeatures(
    Array.from({ length: count }, () => txn({ amount: 400 + ((i + seedOffset) % 5) * 10 }))
  ));
}

describe('Fraud Spike Detector v2', () => {
  describe('trailing baseline (§7.1)', () => {
    it('uses only the trailing N windows and respects the config limit', () => {
      const history = makeHistory(50, 100);
      const baseline = computeTrailingBaseline(history);
      expect(baseline.sample_windows).toBe(DEFAULT_FRAUD_SPIKE_CONFIG.baseline_windows);
    });

    it('excludes the current window — a spike can never inflate its own baseline', () => {
      const history = makeHistory(30, 100); // 30 windows, 100 txns each
      // The API takes prior features SEPARATELY from the current window, so
      // the baseline for THIS window cannot contain its own count.
      const result = detectFraudSpike({
        merchant_id: 'merchant_001',
        current_window: Array.from({ length: 1000 }, () => txn()), // huge spike
        prior_window_features: history,
      });
      expect(result.baseline.mean).toBe(100); // not (30*100+1000)/31
      expect(result.baseline.sample_windows).toBe(30);
    });

    it('reports insufficient_data when fewer than min_samples windows exist', () => {
      const result = detectFraudSpike({
        merchant_id: 'm1',
        current_window: [txn()],
        prior_window_features: makeHistory(10, 100),
      });
      expect(result.failure_state).toBe('insufficient_data');
      expect(result.confidence).toBe('low');
    });
  });

  describe('trailing_counts (real history for display — never synthesized)', () => {
    it('returns the real chronological window counts, most recent last, capped', () => {
      // 35 prior windows with DISTINCT counts so real data is distinguishable
      // from any synthesis around a mean.
      const history = Array.from({ length: 35 }, (_, i) =>
        extractWindowFeatures(Array.from({ length: 80 + i }, () => txn()))
      );
      const result = detectFraudSpike({
        merchant_id: 'merchant_001',
        current_window: Array.from({ length: 100 }, () => txn()),
        prior_window_features: history,
      });
      const counts = result.baseline.trailing_counts!;
      expect(counts).toHaveLength(20); // capped at TRAILING_COUNTS_CAP
      // The LAST 20 real windows, in order: counts 95..114 (i = 15..34).
      expect(counts[0]).toBe(95);
      expect(counts[counts.length - 1]).toBe(114);
      // Chronological ascending — the exact inputs, not jitter around the mean.
      expect(counts).toEqual(counts.slice().sort((a, b) => a - b));
      // Every value is one of the real inputs.
      for (const c of counts) expect(c).toBeGreaterThanOrEqual(95);
      // The mean is computed over all 30 baseline windows; the counts array is
      // a real subset of them.
      expect(result.baseline.mean).toBeGreaterThan(0);
    });

    it('never backfills: a short history returns fewer real points, not fakes', () => {
      // 5 real windows (below min_samples → insufficient_data path) — the
      // counts that exist are still the REAL 5, no padding to 20.
      const history = Array.from({ length: 5 }, (_, i) =>
        extractWindowFeatures(Array.from({ length: 30 + i * 7 }, () => txn()))
      );
      const result = detectFraudSpike({
        merchant_id: 'm1',
        current_window: [txn()],
        prior_window_features: history,
      });
      expect(result.failure_state).toBe('insufficient_data');
      expect(result.baseline.trailing_counts).toEqual([30, 37, 44, 51, 58]);
      expect(result.baseline.trailing_counts).toHaveLength(5);
    });
  });

  describe('raw anomaly score', () => {
    it('is ~0 for a window matching the baseline', () => {
      const history = makeHistory(35, 100);
      const baseline = computeTrailingBaseline(history);
      const current = extractWindowFeatures(Array.from({ length: 100 }, () => txn()));
      expect(Math.abs(rawAnomalyScore(current, baseline))).toBeLessThan(1.5);
    });

    it('is strongly positive for a 5x spike', () => {
      const history = makeHistory(35, 100);
      const baseline = computeTrailingBaseline(history);
      const spike = extractWindowFeatures(Array.from({ length: 500 }, () => txn()));
      expect(rawAnomalyScore(spike, baseline)).toBeGreaterThan(3);
    });
  });

  describe('calibration + confidence (§7.3, §7.4)', () => {
    it('maps score to a probability in [0,1] monotonically', () => {
      const cal = DEFAULT_FRAUD_SPIKE_CONFIG.calibration;
      expect(applyCalibration(0, cal)).toBeGreaterThan(0);
      expect(applyCalibration(0, cal)).toBeLessThan(1);
      expect(applyCalibration(5, cal)).toBeGreaterThan(applyCalibration(0, cal));
      expect(applyCalibration(100, cal)).toBeLessThanOrEqual(1);
    });

    it('confidence is deterministic: low sample => low, mid-band => medium, extreme => high', () => {
      expect(computeConfidence(10, 0.99)).toBe('low');
      expect(computeConfidence(35, 0.5)).toBe('medium');
      expect(computeConfidence(35, 0.3)).toBe('medium');
      expect(computeConfidence(35, 0.95)).toBe('high');
      expect(computeConfidence(35, 0.05)).toBe('high');
    });
  });

  describe('detectFraudSpike end-to-end', () => {
    it('flags a genuine spike with high calibrated probability', () => {
      const history = makeHistory(35, 100);
      const spikeTxns = Array.from({ length: 600 }, () => txn({ amount: 1500, customer_id: 'cust_attack_1', card_hash: 'card_attack' }));
      const result = detectFraudSpike({
        merchant_id: 'merchant_001',
        current_window: spikeTxns,
        prior_window_features: history,
      });
      expect(result.is_spike).toBe(true);
      expect(result.calibrated_probability).toBeGreaterThan(0.5);
      expect(result.confidence).toBe('high');
      expect(result.baseline.sample_windows).toBe(30);
      expect(result.affected_transaction_ids).toHaveLength(600);
      expect(result.affected_transactions_value).toBe(600 * 1500);
    });

    it('does not flag normal traffic', () => {
      const history = makeHistory(35, 100);
      const result = detectFraudSpike({
        merchant_id: 'merchant_001',
        current_window: Array.from({ length: 98 }, () => txn()),
        prior_window_features: history,
      });
      expect(result.is_spike).toBe(false);
      expect(result.calibrated_probability).toBeLessThan(0.5);
    });

    it('includes the module contract fields on every output', () => {
      const history = makeHistory(35, 100);
      const result = detectFraudSpike({
        merchant_id: 'merchant_001',
        current_window: [txn()],
        prior_window_features: history,
      });
      expect(result.module).toBe('fraud_spike');
      expect(result.detector_version).toBe('fraud-spike-v2');
      expect(result.merchant_id).toBe('merchant_001');
      expect(typeof result.calibrated_probability).toBe('number');
      expect(['low', 'medium', 'high']).toContain(result.confidence);
    });
  });
});
