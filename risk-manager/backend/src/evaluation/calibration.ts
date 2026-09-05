/**
 * Logistic-regression calibration (§7.3).
 * Fits p(label | raw_score) = sigmoid(intercept + slope * raw_score) on the
 * DEV SPLIT ONLY, via batch gradient descent. Applied to held-out test.
 * Calibration quality is reported with the Brier score + reliability curve.
 */

export interface LogisticFit {
  intercept: number;
  slope: number;
  iterations: number;
  converged: boolean;
  final_loss: number;
}

export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

export function fitLogistic(
  xs: number[],
  ys: number[],
  opts: { lr?: number; iterations?: number; l2?: number } = {}
): LogisticFit {
  const lr = opts.lr ?? 0.15;
  const iterations = opts.iterations ?? 8000;
  const l2 = opts.l2 ?? 0.01;

  if (xs.length !== ys.length || xs.length === 0) {
    throw new Error('fitLogistic: xs and ys must be non-empty and same length');
  }

  // Standardize x for numerical stability; keep transform parameters.
  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const xStd = Math.sqrt(xs.reduce((a, b) => a + (b - xMean) ** 2, 0) / xs.length) || 1;
  const zs = xs.map((x) => (x - xMean) / xStd);

  let intercept = 0;
  let slope = 0;
  let prevLoss = Infinity;
  let converged = false;

  for (let i = 0; i < iterations; i++) {
    let gradIntercept = 0;
    let gradSlope = 0;
    let loss = 0;

    for (let j = 0; j < zs.length; j++) {
      const p = sigmoid(intercept + slope * zs[j]);
      const y = ys[j];
      loss += -(y * Math.log(Math.max(p, 1e-12)) + (1 - y) * Math.log(Math.max(1 - p, 1e-12)));
      const err = p - y;
      gradIntercept += err;
      gradSlope += err * zs[j];
    }

    loss /= zs.length;
    gradIntercept = gradIntercept / zs.length + l2 * intercept;
    gradSlope = gradSlope / zs.length + l2 * slope;

    intercept -= lr * gradIntercept;
    slope -= lr * gradSlope;

    if (Math.abs(prevLoss - loss) < 1e-8) {
      converged = true;
      break;
    }
    prevLoss = loss;
  }

  // Un-standardize slope back to raw-score space:
  //   p = sigmoid(intercept + slope_std * (x - xMean)/xStd)
  //     = sigmoid((intercept - slope_std*xMean/xStd) + (slope_std/xStd)*x)
  const rawSlope = slope / xStd;
  const rawIntercept = intercept - (slope * xMean) / xStd;

  return {
    intercept: rawIntercept,
    slope: rawSlope,
    iterations,
    converged,
    final_loss: prevLoss,
  };
}

export function applyLogistic(fit: { intercept: number; slope: number }, rawScore: number): number {
  return sigmoid(fit.intercept + fit.slope * rawScore);
}

/** Brier score = mean((p_i - y_i)^2). Lower is better; 0.25 = coin flip. */
export function brierScore(probabilities: number[], labels: number[]): number {
  if (probabilities.length !== labels.length || probabilities.length === 0) return NaN;
  let sum = 0;
  for (let i = 0; i < probabilities.length; i++) {
    sum += (probabilities[i] - labels[i]) ** 2;
  }
  return sum / probabilities.length;
}

/** Reliability curve: bucket predicted probabilities, compare to observed rates. */
export function reliabilityCurve(probabilities: number[], labels: number[], bins = 10): Array<{ bucket: string; predicted_mean: number; observed_rate: number; count: number }> {
  const out = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const idx = probabilities.map((p, i) => ({ p, y: labels[i], i })).filter(({ p }) => p >= lo && (p < hi || (b === bins - 1 && p <= 1)));
    if (idx.length === 0) continue;
    const predictedMean = idx.reduce((a, r) => a + r.p, 0) / idx.length;
    const observed = idx.reduce((a, r) => a + r.y, 0) / idx.length;
    out.push({
      bucket: `${lo.toFixed(1)}-${hi.toFixed(1)}`,
      predicted_mean: round4(predictedMean),
      observed_rate: round4(observed),
      count: idx.length,
    });
  }
  return out;
}

/** PR-AUC via precision-recall points (average precision, stepwise). */
export function prAuc(probabilities: number[], labels: number[]): number {
  const order = probabilities.map((p, i) => ({ p, y: labels[i] })).sort((a, b) => b.p - a.p);
  let tp = 0;
  let fp = 0;
  let prevRecall = 0;
  let auc = 0;
  const totalPositives = labels.reduce((a, b) => a + b, 0);
  if (totalPositives === 0) return 0;

  for (const { y } of order) {
    if (y === 1) tp++;
    else fp++;
    const recall = tp / totalPositives;
    const precision = tp / (tp + fp);
    auc += (recall - prevRecall) * precision;
    prevRecall = recall;
  }
  return round6(auc);
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function round6(v: number): number {
  return Math.round(v * 1000000) / 1000000;
}
