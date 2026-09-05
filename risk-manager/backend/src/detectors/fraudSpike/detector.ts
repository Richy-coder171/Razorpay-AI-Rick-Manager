/**
 * Fraud Spike Detector v2 (§7) — primary module.
 *
 * - Trailing baseline over prior N windows, EXCLUDING the current window,
 *   so a spike can never inflate its own baseline (§7.1).
 * - Confidence is deterministic (§7.4): sample size + distance from boundary.
 *   The LLM only ever echoes it.
 * - Calibration (z-score -> probability) is fitted by the evaluation harness
 *   (§7.3) via logistic regression on the dev split. The fitted weights and
 *   tuned threshold live in evaluation/fraud-spike/results/calibration.json
 *   and are loaded at module startup. If that file is missing the detector
 *   falls back to bootstrap defaults — VISIBLY: every result carries
 *   calibration_source: "fitted" | "bootstrap_default" so a silent fallback
 *   can never masquerade as the evaluated configuration.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Transaction,
  FraudSpikeResult,
  ConfidenceLevel,
} from '../../types';
import { extractWindowFeatures, mean, std, WindowFeatures } from '../../features';

export const FRAUD_SPIKE_DETECTOR_VERSION = 'fraud-spike-v2';

export interface TrailingBaseline {
  mean: number;
  std: number;
  sample_windows: number;
  window_type: string;
  failure_rate_mean: number;
  amount_variance_mean: number;
  unique_customer_ratio_mean: number;
  /** Real per-window transaction counts (chronological, most recent last) — displayed, never synthesized. */
  trailing_counts: number[];
}

export interface FraudSpikeDetectorConfig {
  window_type: string;
  window_size_ms: number;
  baseline_windows: number; // trailing N windows (§7.1, default 30)
  min_samples: number;      // §7.4 MIN_SAMPLES (default 30)
  calibration: { intercept: number; slope: number }; // logistic: p = sigmoid(intercept + slope*score)
  spike_threshold: number; // is_spike when p >= threshold (fitted on dev by default)
}

export const DEFAULT_FRAUD_SPIKE_CONFIG: FraudSpikeDetectorConfig = {
  window_type: '10m',
  window_size_ms: 10 * 60 * 1000,
  baseline_windows: 30,
  min_samples: 30,
  // Bootstrap mapping; the ONLY fallback, used when the fitted calibration
  // file (evaluation/fraud-spike/results/calibration.json, written by
  // `npm run evaluate`) is absent. Runtime output exposes which one ran.
  calibration: { intercept: -3.5, slope: 1.2 },
  spike_threshold: 0.5,
};

export type CalibrationSource = 'fitted' | 'bootstrap_default';

interface FittedCalibration {
  intercept: number;
  slope: number;
  threshold: number;
}

/** Load the fitted calibration written by `npm run evaluate`; fall back loudly. */
export function loadFittedCalibration(file?: string): { fitted: FittedCalibration | null; source: CalibrationSource } {
  const calibrationFile = file || path.resolve(__dirname, '../../../evaluation/fraud-spike/results/calibration.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(calibrationFile, 'utf8')) as Partial<FittedCalibration>;
    if (
      typeof parsed.intercept === 'number' &&
      Number.isFinite(parsed.intercept) &&
      typeof parsed.slope === 'number' &&
      Number.isFinite(parsed.slope) &&
      typeof parsed.threshold === 'number' &&
      Number.isFinite(parsed.threshold)
    ) {
      return {
        fitted: { intercept: parsed.intercept, slope: parsed.slope, threshold: parsed.threshold },
        source: 'fitted',
      };
    }
    return { fitted: null, source: 'bootstrap_default' };
  } catch {
    // Missing or malformed file: fall back to bootstrap defaults, visibly.
    return { fitted: null, source: 'bootstrap_default' };
  }
}

/** The live detector configuration: fitted weights when available, bootstrap otherwise. */
const FITTED = loadFittedCalibration();
export const LIVE_FRAUD_SPIKE_CONFIG: FraudSpikeDetectorConfig = FITTED.fitted
  ? {
      ...DEFAULT_FRAUD_SPIKE_CONFIG,
      calibration: { intercept: FITTED.fitted.intercept, slope: FITTED.fitted.slope },
      spike_threshold: FITTED.fitted.threshold,
    }
  : DEFAULT_FRAUD_SPIKE_CONFIG;

export const CALIBRATION_SOURCE: CalibrationSource = FITTED.source;

/** How many real trailing window counts the detector returns for display. */
export const TRAILING_COUNTS_CAP = 20;

/** Raw anomaly score: primary z-score of count + secondary z-scores (§7.3). */
export function rawAnomalyScore(current: WindowFeatures, baseline: TrailingBaseline): number {
  const countZ = baseline.std > 0 ? (current.transaction_count - baseline.mean) / baseline.std : 0;

  // Secondary signals: failure-rate delta and concentration (count/customer ratio).
  const custRatio = current.unique_customers > 0 ? current.transaction_count / current.unique_customers : 0;
  const baselineCustRatio = baseline.unique_customer_ratio_mean > 0 ? baseline.unique_customer_ratio_mean : 1;
  const concentrationDelta = custRatio / baselineCustRatio;

  const failureDelta = current.failure_rate - baseline.failure_rate_mean;

  // Weighted combination; weights are documented heuristics, NOT fitted here.
  const score = 0.7 * countZ + 0.2 * Math.max(0, concentrationDelta - 1) * 3 + 0.1 * Math.max(0, failureDelta) * 5;
  return score;
}

/** Logistic calibration: p = sigmoid(intercept + slope * raw_score). */
export function applyCalibration(rawScore: number, cal: { intercept: number; slope: number }): number {
  const z = cal.intercept + cal.slope * rawScore;
  return 1 / (1 + Math.exp(-z));
}

/** Deterministic confidence (§7.4) — never asserted by the LLM. */
export function computeConfidence(
  sampleSize: number,
  calibratedProbability: number,
  minSamples = DEFAULT_FRAUD_SPIKE_CONFIG.min_samples
): ConfidenceLevel {
  if (sampleSize < minSamples) return 'low';
  if (calibratedProbability >= 0.3 && calibratedProbability <= 0.7) return 'medium';
  return 'high';
}

/** Trailing baseline over the prior N windows, excluding the current one (§7.1). */
export function computeTrailingBaseline(
  priorFeatures: WindowFeatures[],
  config = DEFAULT_FRAUD_SPIKE_CONFIG
): TrailingBaseline {
  const trailing = priorFeatures.slice(-config.baseline_windows);
  const counts = trailing.map((f) => f.transaction_count);
  const sampleWindows = trailing.length;

  const m = mean(counts);
  let s = std(counts);
  if (sampleWindows > 0 && s === 0 && m > 0) s = Math.sqrt(m); // Poisson floor: std ~= sqrt(mean)

  return {
    mean: m,
    std: s,
    sample_windows: sampleWindows,
    window_type: config.window_type,
    failure_rate_mean: mean(trailing.map((f) => f.failure_rate)),
    amount_variance_mean: mean(trailing.map((f) => f.amount_variance)),
    unique_customer_ratio_mean:
      mean(
        trailing.map((f) => (f.unique_customers > 0 ? f.transaction_count / f.unique_customers : 1))
      ) || 1,
    // Real counts for display: chronological (the windows are generated in
    // order), most recent last. Capped so the payload stays small; NEVER
    // backfilled or synthesized — a shorter history shows fewer real points.
    trailing_counts: trailing.slice(-TRAILING_COUNTS_CAP).map((f) => f.transaction_count),
  };
}

export interface DetectFraudSpikeInput {
  merchant_id: string;
  current_window: Transaction[];
  prior_window_features: WindowFeatures[]; // TRAILING only — must exclude current window
  window_start?: string;
  window_end?: string;
  config?: Partial<FraudSpikeDetectorConfig>;
}

export function detectFraudSpike(input: DetectFraudSpikeInput): FraudSpikeResult {
  const callerOverrode = !!(input.config?.calibration || input.config?.spike_threshold !== undefined);
  const config = { ...LIVE_FRAUD_SPIKE_CONFIG, ...input.config };
  // A caller-supplied calibration is by definition not the fitted/baseline pair;
  // only the live configuration claims its source. Explicit input.config => unknown.
  const calibrationSource: CalibrationSource = callerOverrode ? 'bootstrap_default' : CALIBRATION_SOURCE;
  const current = extractWindowFeatures(
    input.current_window,
    input.window_start,
    input.window_end,
    config.window_size_ms
  );
  const baseline = computeTrailingBaseline(input.prior_window_features, config);

  // Insufficient data is a failure state, not a guess (§0).
  if (baseline.sample_windows < config.min_samples) {
    return {
      module: 'fraud_spike',
      detector_version: FRAUD_SPIKE_DETECTOR_VERSION,
      merchant_id: input.merchant_id,
      is_spike: false,
      anomaly_score: 0,
      calibrated_probability: 0,
      confidence: 'low',
      failure_state: 'insufficient_data',
      affected_transaction_ids: input.current_window.map((t) => t.id),
      affected_transactions_value: current.total_amount,
      calibration_source: calibrationSource,
      baseline: {
        mean: round2(baseline.mean),
        std: round2(baseline.std),
        window_type: baseline.window_type,
        sample_windows: baseline.sample_windows,
        trailing_counts: baseline.trailing_counts,
      },
    };
  }

  const anomalyScore = rawAnomalyScore(current, baseline);
  const probability = applyCalibration(anomalyScore, config.calibration);
  const confidence = computeConfidence(baseline.sample_windows, probability, config.min_samples);

  return {
    module: 'fraud_spike',
    detector_version: FRAUD_SPIKE_DETECTOR_VERSION,
    merchant_id: input.merchant_id,
    is_spike: probability >= config.spike_threshold,
    anomaly_score: round2(anomalyScore),
    calibrated_probability: round2(probability),
    confidence,
    failure_state: null,
    affected_transaction_ids: input.current_window.map((t) => t.id),
    affected_transactions_value: current.total_amount,
    calibration_source: calibrationSource,
    baseline: {
      mean: round2(baseline.mean),
      std: round2(baseline.std),
      window_type: baseline.window_type,
      sample_windows: baseline.sample_windows,
      trailing_counts: baseline.trailing_counts,
    },
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
