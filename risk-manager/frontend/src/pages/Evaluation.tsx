import { useState, useEffect } from 'react';
import { fetchEvaluation } from '../services/api';
import type { EvaluationMetrics } from '@risk-manager/shared';
import { PageHeader, Card, CardHeader, Badge, Button } from '../components/ui';
import { ChartIcon, RefreshIcon } from '../components/icons';

export default function Evaluation() {
  const [metrics, setMetrics] = useState<EvaluationMetrics | null>(null);
  const [notEvaluated, setNotEvaluated] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadEvaluation();
  }, []);

  const loadEvaluation = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchEvaluation();
      if ('status' in data && data.status === 'not_evaluated') {
        setNotEvaluated(data.message);
        setMetrics(null);
      } else {
        setMetrics(data as EvaluationMetrics);
        setNotEvaluated(null);
      }
    } catch (err) {
      setError((err as Error).message);
      console.error('Failed to load evaluation:', err);
    } finally {
      setLoading(false);
    }
  };

  const c = metrics?.confusion_matrix;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Model Evaluation"
        subtitle="Fraud-spike detector on the pinned held-out test set"
        badge={metrics && <Badge tone="green">threshold {metrics.decision_threshold}</Badge>}
        actions={<Button variant="secondary" onClick={loadEvaluation}><RefreshIcon className="h-4 w-4" /> Reload</Button>}
      />

      {loading ? (
        <Card className="p-8 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-600 mx-auto"></div>
          <p className="mt-4 text-slate-600">Loading evaluation…</p>
        </Card>
      ) : error ? (
        <Card className="p-8 text-center text-red-600 text-sm">{error}</Card>
      ) : notEvaluated ? (
        <Card className="p-8 text-center text-slate-500">{notEvaluated}</Card>
      ) : metrics ? (
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Held-out Test Metrics"
              subtitle={`Dataset ${metrics.dataset} · ${metrics.windows} windows · ${metrics.positives} positives (${(metrics.prevalence * 100).toFixed(1)}% prevalence)`}
              icon={<ChartIcon className="h-5 w-5" />}
            />
            <div className="px-6 pb-6">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <div className="text-center p-4 bg-brand-50 rounded-lg">
                  <div className="text-3xl font-bold text-brand-700">{(metrics.precision * 100).toFixed(1)}%</div>
                  <div className="text-sm text-slate-600">Precision</div>
                </div>
                <div className="text-center p-4 bg-emerald-50 rounded-lg">
                  <div className="text-3xl font-bold text-emerald-700">{(metrics.recall * 100).toFixed(1)}%</div>
                  <div className="text-sm text-slate-600">Recall</div>
                </div>
                <div className="text-center p-4 bg-violet-50 rounded-lg">
                  <div className="text-3xl font-bold text-violet-700">{(metrics.f1 * 100).toFixed(1)}%</div>
                  <div className="text-sm text-slate-600">F1 Score</div>
                </div>
                <div className="text-center p-4 bg-amber-50 rounded-lg">
                  <div className="text-3xl font-bold text-amber-700">{(metrics.accuracy * 100).toFixed(1)}%</div>
                  <div className="text-sm text-slate-600">Accuracy</div>
                </div>
                <div className="text-center p-4 bg-red-50 rounded-lg">
                  <div className="text-3xl font-bold text-red-700">{(metrics.fpr * 100).toFixed(1)}%</div>
                  <div className="text-sm text-slate-600">False Positive Rate</div>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div><span className="text-slate-500">PR-AUC:</span> <span className="font-medium">{metrics.pr_auc.toFixed(3)}</span></div>
                <div><span className="text-slate-500">Brier score:</span> <span className="font-medium">{metrics.brier_score.toFixed(3)}</span></div>
                <div><span className="text-slate-500">FP cost:</span> <span className="font-medium">₹{metrics.false_positive_cost_inr.toLocaleString('en-IN')}</span></div>
                <div><span className="text-slate-500">Generated:</span> <span className="font-medium">{new Date(metrics.generated_at).toLocaleDateString()}</span></div>
              </div>
            </div>
          </Card>

          {c && (
            <Card>
              <CardHeader title="Confusion Matrix" subtitle={`Threshold ${metrics.decision_threshold} on held-out test`} />
              <div className="px-6 pb-6 flex flex-col items-center gap-4">
                <table className="border-collapse">
                  <thead>
                    <tr>
                      <th className="border p-3 bg-slate-100"></th>
                      <th className="border p-3 bg-slate-100 text-center" colSpan={2}>Predicted</th>
                    </tr>
                    <tr>
                      <th className="border p-3 bg-slate-100"></th>
                      <th className="border p-3 bg-emerald-100 text-center">Negative</th>
                      <th className="border p-3 bg-red-100 text-center">Positive</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="border p-3 bg-slate-100 font-medium">Actual Negative</td>
                      <td className="border p-3 text-center text-emerald-700 font-bold">{c.tn}</td>
                      <td className="border p-3 text-center text-red-700 font-bold">{c.fp}</td>
                    </tr>
                    <tr>
                      <td className="border p-3 bg-slate-100 font-medium">Actual Positive</td>
                      <td className="border p-3 text-center text-red-700 font-bold">{c.fn}</td>
                      <td className="border p-3 text-center text-emerald-700 font-bold">{c.tp}</td>
                    </tr>
                  </tbody>
                </table>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div><span className="text-emerald-700 font-medium">True Positives:</span> {c.tp}</div>
                  <div><span className="text-red-700 font-medium">False Positives:</span> {c.fp}</div>
                  <div><span className="text-red-700 font-medium">False Negatives:</span> {c.fn}</div>
                  <div><span className="text-emerald-700 font-medium">True Negatives:</span> {c.tn}</div>
                </div>
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="Methodology" />
            <div className="px-6 pb-6 text-sm text-slate-600 space-y-2">
              <p><strong>Dataset:</strong> Seeded synthetic timeline frozen with a SHA-256 manifest; chronological 60/20/20 train/dev/test split (never shuffled).</p>
              <p><strong>Baselines:</strong> Trailing 30-window baseline per merchant; the current window is structurally excluded so a spike can never inflate its own baseline.</p>
              <p><strong>Calibration:</strong> Logistic regression fitted on the train split; decision threshold tuned on dev (max F1); reported once on the held-out test.</p>
              <p><strong>FP cost:</strong> Legitimate INR transaction value in windows wrongly flagged.</p>
              <p>{metrics.notes}</p>
            </div>
          </Card>
        </div>
      ) : (
        <Card className="p-8 text-center text-slate-500">Failed to load evaluation metrics.</Card>
      )}
    </div>
  );
}
