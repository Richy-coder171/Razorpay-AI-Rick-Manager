/**
 * Evaluation harness (§7.6) — the official bar for the primary module.
 *
 * Method:
 *  1. Walk the timeline chronologically; the baseline for window i uses ONLY
 *     trailing windows (i-30..i-1) — never the current window (leak-proof).
 *  2. Fit logistic calibration label ~ raw_score on the TRAIN split.
 *  3. Tune the decision threshold on the DEV split (maximize F1).
 *  4. Report on the HELD-OUT TEST split against the pinned test file:
 *     precision/recall/F1/FPR/FNR/accuracy + PR-AUC + Brier + reliability
 *     curve + false-positive cost (legitimate INR value wrongly flagged).
 *
 * `npm run evaluate` regenerates evaluation/fraud-spike/results/metrics.json
 * and confusion_matrix.json from the pinned test file. It never fabricates
 * numbers; if the test file is missing, it fails loudly.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LabeledWindow } from '../data/generator';
import { FrozenDataset } from '../data/generate-data';
import {
  rawAnomalyScore,
  computeTrailingBaseline,
  applyCalibration,
  DEFAULT_FRAUD_SPIKE_CONFIG,
  FRAUD_SPIKE_DETECTOR_VERSION,
} from '../detectors/fraudSpike';
import { extractWindowFeatures, WindowFeatures } from '../features';
import { fitLogistic, applyLogistic, brierScore, reliabilityCurve, prAuc, LogisticFit } from './calibration';
import { sha256Hex } from '../utils/crypto';

export interface ScoredWindow {
  window_index: number;
  merchant_id: string;
  raw_score: number;
  probability: number;
  label: boolean;
  sample_windows: number;
  window_value: number; // total INR in the window
  evaluated: boolean;   // false during warm-up (insufficient baseline)
}

/** Score every window chronologically with trailing-only baselines. */
export function scoreTimeline(windows: LabeledWindow[]): ScoredWindow[] {
  const perMerchant: Map<string, WindowFeatures[]> = new Map();
  const scored: ScoredWindow[] = [];

  for (const w of windows) {
    const prior = perMerchant.get(w.merchant_id) || [];
    const baseline = computeTrailingBaseline(prior);

    const current = extractWindowFeatures(w.transactions, w.window_start, w.window_end);
    const raw = baseline.sample_windows >= DEFAULT_FRAUD_SPIKE_CONFIG.min_samples ? rawAnomalyScore(current, baseline) : 0;
    const evaluated = baseline.sample_windows >= DEFAULT_FRAUD_SPIKE_CONFIG.min_samples;

    scored.push({
      window_index: w.window_index,
      merchant_id: w.merchant_id,
      raw_score: raw,
      probability: 0, // filled after calibration fit
      label: w.is_fraud_spike,
      sample_windows: baseline.sample_windows,
      window_value: current.total_amount,
      evaluated,
    });

    prior.push(current);
    perMerchant.set(w.merchant_id, prior);
  }

  return scored;
}

export function bestThresholdByF1(probabilities: number[], labels: number[], grid = 200): number {
  let best = 0.5;
  let bestF1 = -1;
  for (let i = 0; i <= grid; i++) {
    const threshold = i / grid;
    let tp = 0, fp = 0, fn = 0;
    for (let j = 0; j < probabilities.length; j++) {
      const pred = probabilities[j] >= threshold;
      if (pred && labels[j] === 1) tp++;
      else if (pred && labels[j] === 0) fp++;
      else if (!pred && labels[j] === 1) fn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    if (f1 > bestF1) {
      bestF1 = f1;
      best = threshold;
    }
  }
  return best;
}

export interface ConfusionCounts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export function confusion(predictions: boolean[], labels: boolean[]): ConfusionCounts {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < predictions.length; i++) {
    if (predictions[i] && labels[i]) tp++;
    else if (predictions[i] && !labels[i]) fp++;
    else if (!predictions[i] && labels[i]) fn++;
    else tn++;
  }
  return { tp, fp, fn, tn };
}

export interface ThresholdMetrics {
  threshold: number;
  precision: number;
  recall: number;
  f1: number;
  fpr: number;
  fnr: number;
  accuracy: number;
  confusion: ConfusionCounts;
  fp_cost_inr: number;
  value_protected_inr: number;
}

export function metricsAtThreshold(scored: ScoredWindow[], threshold: number): ThresholdMetrics {
  const evaluable = scored.filter((s) => s.evaluated);
  const predictions = evaluable.map((s) => s.probability >= threshold);
  const labels = evaluable.map((s) => s.label);

  const c = confusion(predictions, labels);
  const precision = c.tp + c.fp > 0 ? c.tp / (c.tp + c.fp) : 0;
  const recall = c.tp + c.fn > 0 ? c.tp / (c.tp + c.fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  // FALSE-POSITIVE COST (§7.6): legitimate transaction value wrongly flagged.
  let fpCost = 0;
  // VALUE PROTECTED: fraudulent transaction value in windows the detector
  // caught (true positives) — the mirror image of the FP cost, computed with
  // identical accounting (window_value over held-out test windows).
  let valueProtected = 0;
  for (const s of evaluable) {
    if (s.probability >= threshold && !s.label) fpCost += s.window_value;
    if (s.probability >= threshold && s.label) valueProtected += s.window_value;
  }

  return {
    threshold: round4(threshold),
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(f1),
    fpr: round4(c.fp + c.tn > 0 ? c.fp / (c.fp + c.tn) : 0),
    fnr: round4(c.fn + c.tp > 0 ? c.fn / (c.fn + c.tp) : 0),
    accuracy: round4((c.tp + c.tn) / Math.max(evaluable.length, 1)),
    confusion: c,
    fp_cost_inr: Math.round(fpCost),
    value_protected_inr: Math.round(valueProtected),
  };
}

export function loadDataset(file: string): FrozenDataset {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as FrozenDataset;
  if (!parsed.dataset_name || !Array.isArray(parsed.windows)) {
    throw new Error(`Malformed dataset file: ${file}`);
  }
  return parsed;
}

export interface RunEvaluationOptions {
  dataDir?: string;
  outDir?: string;
  quiet?: boolean;
}

/**
 * Full pipeline: score train -> fit calibration -> tune threshold on dev ->
 * report on held-out test. Writes metrics.json, confusion_matrix.json and
 * calibration.json (fitted weights, loaded by the live detector at runtime).
 */
export function runEvaluation(opts: RunEvaluationOptions = {}) {
  const dataDir = path.resolve(__dirname, '../../data/test');
  const outDir = opts.outDir || path.resolve(__dirname, '../../evaluation/fraud-spike/results');

  const trainFile = path.join(dataDir, 'train-train-v1.json');
  const devFile = path.join(dataDir, 'train-dev-v1.json');
  const testFile = path.join(dataDir, 'held-out-test-v1.json');

  for (const f of [trainFile, devFile, testFile]) {
    if (!fs.existsSync(f)) {
      throw new Error(`Missing pinned dataset: ${f}. Run \`npm run generate-data -- --seed 42\` first.`);
    }
  }

  const train = loadDataset(trainFile);
  const dev = loadDataset(devFile);
  const test = loadDataset(testFile);
  const testFileSha = sha256Hex(fs.readFileSync(testFile, 'utf8'));

  // 1. Score all splits chronologically (trailing baselines only).
  const trainScored = scoreTimeline(train.windows);
  const devScored = scoreTimeline(dev.windows);
  const testScored = scoreTimeline(test.windows);

  // 2. Fit calibration on TRAIN split only (§7.3).
  const fitXs = trainScored.filter((s) => s.evaluated).map((s) => s.raw_score);
  const fitYs = trainScored.filter((s) => s.evaluated).map((s) => (s.label ? 1 : 0));
  const fit = fitLogistic(fitXs, fitYs, { lr: 0.2, iterations: 12000 });

  const withProb = (scored: ScoredWindow[]): ScoredWindow[] =>
    scored.map((s) => ({ ...s, probability: s.evaluated ? applyLogistic(fit, s.raw_score) : 0 }));

  const trainProb = withProb(trainScored).filter((s) => s.evaluated).map((s) => s.probability);
  const trainLab = trainScored.filter((s) => s.evaluated).map((s) => (s.label ? 1 : 0));

  const devWith = withProb(devScored);
  const testWith = withProb(testScored);

  // 3. Tune decision threshold on DEV split (maximize F1).
  const devEval = devWith.filter((s) => s.evaluated);
  const threshold = bestThresholdByF1(devEval.map((s) => s.probability), devEval.map((s) => (s.label ? 1 : 0)));

  // 4. Held-out test metrics.
  const testEval = testWith.filter((s) => s.evaluated);
  const testProbs = testEval.map((s) => s.probability);
  const testLabels = testEval.map((s) => (s.label ? 1 : 0));
  const testPreds = testProbs.map((p) => p >= threshold);

  const c = confusion(testPreds, testEval.map((s) => s.label));
  const tm = metricsAtThreshold(testWith, threshold);

  const metrics = {
    module: 'fraud_spike' as const,
    detector_version: FRAUD_SPIKE_DETECTOR_VERSION,
    decision_threshold: round4(threshold),
    dataset: 'held-out-test-v1',
    dataset_sha256: testFileSha,
    generated_at: new Date().toISOString(),
    windows: testEval.length,
    warmup_windows_excluded: testWith.length - testEval.length,
    positives: c.tp + c.fn,
    prevalence: round4((c.tp + c.fn) / Math.max(testEval.length, 1)),
    precision: tm.precision,
    recall: tm.recall,
    f1: tm.f1,
    fpr: tm.fpr,
    fnr: tm.fnr,
    accuracy: tm.accuracy,
    pr_auc: round4(prAuc(testProbs, testLabels)),
    brier_score: round4(brierScore(testProbs, testLabels)),
    false_positive_cost_inr: tm.fp_cost_inr,
    false_positive_windows: c.fp,
    value_protected_inr: tm.value_protected_inr,
    confusion_matrix: c,
    reliability_curve: reliabilityCurve(testProbs, testLabels),
    calibration: {
      method: 'logistic_regression_fit_on_train_split',
      intercept: round6(fit.intercept),
      slope: round6(fit.slope),
      fit_dev_brier: round4(brierScore(devEval.map((s) => s.probability), devEval.map((s) => (s.label ? 1 : 0)))),
      train_fit_converged: fit.converged,
    },
    notes:
      'Chronological 60/20/20 split, trailing-only baselines (current window excluded), threshold tuned on dev, reported on held-out test. False-positive cost = legitimate INR value in windows wrongly flagged.',
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
  fs.writeFileSync(
    path.join(outDir, 'confusion_matrix.json'),
    JSON.stringify({ threshold: metrics.decision_threshold, ...c }, null, 2)
  );
  fs.writeFileSync(
    path.join(outDir, 'calibration.json'),
    JSON.stringify({ intercept: fit.intercept, slope: fit.slope, threshold, fitted_at: new Date().toISOString() }, null, 2)
  );

  if (!opts.quiet) {
    console.log('=== Fraud Spike Detector — Held-out Test Evaluation ===');
    console.log(`dataset:            held-out-test-v1 (sha256 ${testFileSha.slice(0, 16)}…)`);
    console.log(`windows evaluated:  ${testEval.length} (${testWith.length - testEval.length} warm-up excluded)`);
    console.log(`positives:          ${c.tp + c.fn} (prevalence ${(metrics.prevalence * 100).toFixed(1)}%)`);
    console.log(`threshold (dev):    ${threshold.toFixed(3)}`);
    console.log(`precision:          ${metrics.precision.toFixed(4)}`);
    console.log(`recall:             ${metrics.recall.toFixed(4)}`);
    console.log(`f1:                 ${metrics.f1.toFixed(4)}`);
    console.log(`fpr:                ${metrics.fpr.toFixed(4)}`);
    console.log(`fnr:                ${metrics.fnr.toFixed(4)}`);
    console.log(`pr_auc:             ${metrics.pr_auc.toFixed(4)}`);
    console.log(`brier_score:        ${metrics.brier_score.toFixed(4)}`);
    console.log(`false_positives:    ${c.fp} windows`);
    console.log(`false_positive_cost: INR ${tm.fp_cost_inr.toLocaleString('en-IN')} legitimate value flagged`);
    console.log(`value_protected:     INR ${tm.value_protected_inr.toLocaleString('en-IN')} fraudulent value caught (true-positive windows)`);
  }

  return { metrics, fit, threshold };
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function round6(v: number): number {
  return Math.round(v * 1000000) / 1000000;
}

// CLI: npm run evaluate
if (require.main === module) {
  try {
    runEvaluation();
  } catch (err) {
    console.error(`Evaluation failed: ${(err as Error).message}`);
    process.exit(1);
  }
}
