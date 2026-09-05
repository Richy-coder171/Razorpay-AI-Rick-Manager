/**
 * Calibration tests (§7.3) — logistic fit must be monotonic and well-behaved.
 */

import { fitLogistic, applyLogistic, brierScore, reliabilityCurve, prAuc } from './calibration';

describe('Logistic calibration (§7.3)', () => {
  it('fits a monotonically increasing mapping for separable data', () => {
    const xs = [0.1, 0.2, 0.3, 3.0, 4.0, 5.0];
    const ys = [0, 0, 0, 1, 1, 1];
    const fit = fitLogistic(xs, ys, { lr: 0.3, iterations: 5000 });
    expect(applyLogistic(fit, 0.1)).toBeLessThan(0.5);
    expect(applyLogistic(fit, 5.0)).toBeGreaterThan(0.5);
    expect(applyLogistic(fit, 3.0)).toBeGreaterThan(applyLogistic(fit, 0.2));
  });

  it('respects the [0,1] range at extremes', () => {
    const fit = fitLogistic([-5, -3, 3, 5], [0, 0, 1, 1]);
    expect(applyLogistic(fit, -1000)).toBeGreaterThanOrEqual(0);
    expect(applyLogistic(fit, -1000)).toBeLessThan(0.01);
    expect(applyLogistic(fit, 1000)).toBeLessThanOrEqual(1);
    expect(applyLogistic(fit, 1000)).toBeGreaterThan(0.99);
  });

  it('throws on empty/mismatched input', () => {
    expect(() => fitLogistic([], [])).toThrow();
    expect(() => fitLogistic([1], [1, 2])).toThrow();
  });

  it('Brier score: 0 for perfect predictions, ~0.25 for coin flips', () => {
    expect(brierScore([0, 1], [0, 1])).toBe(0);
    expect(brierScore([0.5, 0.5], [0, 1])).toBeCloseTo(0.25, 6);
  });

  it('PR-AUC: 1.0 for a perfect ranking', () => {
    expect(prAuc([0.9, 0.8, 0.1, 0.2], [1, 1, 0, 0])).toBeCloseTo(1.0, 4);
  });

  it('PR-AUC: low for an inverted ranking', () => {
    expect(prAuc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBeLessThan(0.6);
  });

  it('reliability curve buckets probabilities and reports observed rates', () => {
    const curve = reliabilityCurve([0.05, 0.15, 0.95, 0.85, 0.55], [0, 0, 1, 1, 1]);
    expect(curve.length).toBeGreaterThan(0);
    const first = curve.find((c) => c.bucket.startsWith('0.0'));
    expect(first?.count).toBe(1);
    expect(first?.observed_rate).toBe(0);
  });
});
