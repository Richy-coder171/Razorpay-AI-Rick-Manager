import { useState, useEffect } from 'react';
import { fetchDashboard, fetchEvaluation } from '../services/api';
import type { DashboardResponse } from '../services/api';
import type { AuditRecord, EvaluationMetrics } from '@risk-manager/shared';
import { PageHeader, Card, CardHeader, Badge, ModuleBadge, StatCard, Button } from '../components/ui';
import { PulseIcon, ClipboardIcon, AlertIcon, ChartIcon, ScaleIcon, ShieldIcon } from '../components/icons';

export default function Overview() {
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationMetrics | null>(null);
  const [evalStatus, setEvalStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [dash, evalRes] = await Promise.all([fetchDashboard(), fetchEvaluation()]);
      setDashboard(dash);
      if ('status' in evalRes && evalRes.status === 'not_evaluated') {
        setEvalStatus(evalRes.message);
      } else {
        setEvaluation(evalRes as EvaluationMetrics);
      }
    } catch (err) {
      setError((err as Error).message);
      console.error('Failed to load data:', err);
    }
  };

  const recent = dashboard?.recent_decisions ?? [];
  const totals = dashboard?.totals;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Risk Manager Overview"
        subtitle="AI recommends. Deterministic code controls. Humans handle uncertainty."
        badge={<Badge tone="yellow">DEMO / TEST MODE</Badge>}
        actions={<Button variant="secondary" onClick={loadData}>Refresh</Button>}
      />

      {error && (
        <Card className="p-5">
          <div className="flex items-center gap-3 text-red-700">
            <AlertIcon className="h-5 w-5" />
            <span className="text-sm font-medium">Failed to load dashboard: {error}</span>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatCard
          label="Value Protected (held-out est.)"
          value={evaluation ? `₹${Math.round(evaluation.value_protected_inr / 100000)}L` : '—'}
          icon={<ShieldIcon className="h-5 w-5" />}
          tone="blue"
          delay={0}
        />
        <StatCard label="Total Decisions" value={totals?.decisions ?? 0} icon={<ClipboardIcon className="h-5 w-5" />} tone="blue" delay={1} />
        <StatCard label="Human Escalations" value={totals?.escalations ?? 0} icon={<AlertIcon className="h-5 w-5" />} tone="orange" delay={2} />
        <StatCard
          label="FP Cost (held-out est.)"
          value={evaluation ? `₹${evaluation.false_positive_cost_inr.toLocaleString('en-IN')}` : '—'}
          icon={<ScaleIcon className="h-5 w-5" />}
          tone="purple"
          delay={3}
        />
      </div>

      {evaluation && (
        <p className="text-xs text-slate-500 -mt-3 px-1">
          Held-out test-set estimates (dataset {evaluation.dataset}), not live production figures: value protected =
          fraudulent INR volume in the {evaluation.confusion_matrix?.tp ?? 0} true-positive windows; FP cost = legitimate
          INR volume in the {evaluation.false_positive_windows} wrongly flagged windows.
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader title="Fraud Spike Detector Evaluation" subtitle="Held-out test metrics" icon={<ChartIcon className="h-5 w-5" />} />
          {evaluation ? (
            <div className="px-6 pb-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <div className="text-sm text-slate-500">Precision</div>
                  <div className="text-2xl font-bold text-brand-600">{(evaluation.precision * 100).toFixed(1)}%</div>
                </div>
                <div>
                  <div className="text-sm text-slate-500">Recall</div>
                  <div className="text-2xl font-bold text-brand-600">{(evaluation.recall * 100).toFixed(1)}%</div>
                </div>
                <div>
                  <div className="text-sm text-slate-500">F1 Score</div>
                  <div className="text-2xl font-bold text-brand-600">{(evaluation.f1 * 100).toFixed(1)}%</div>
                </div>
                <div>
                  <div className="text-sm text-slate-500">Accuracy</div>
                  <div className="text-2xl font-bold text-brand-600">{(evaluation.accuracy * 100).toFixed(1)}%</div>
                </div>
              </div>
              <div className="mt-4 text-xs text-slate-500">
                Dataset: {evaluation.dataset} · Windows: {evaluation.windows} · Positives: {evaluation.positives} ·
                FP cost: ₹{evaluation.false_positive_cost_inr.toLocaleString('en-IN')}
              </div>
            </div>
          ) : (
            <div className="px-6 pb-6 text-sm text-slate-500">
              {evalStatus ?? 'Evaluation metrics not loaded.'}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Pipeline" subtitle="Every event flows through the same chain" icon={<PulseIcon className="h-5 w-5" />} />
          <div className="px-6 pb-6">
            <div className="bg-slate-50 p-4 rounded-lg font-mono text-xs leading-relaxed text-slate-700">
              <pre>{`Event
  ↓
Feature Layer
  ↓
Risk Detector
  ↓
Calibrated Score
  ↓
Risk Manager Agent (AI)
  ↓
Output Guard
  ↓
Policy Engine
  ↓
Action / Escalation
  ↓
Audit Log`}</pre>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Recent Decisions" subtitle="Newest first, from the hash-chained audit log" icon={<ClipboardIcon className="h-5 w-5" />} />
        <div className="px-6 pb-6">
          {recent.length > 0 ? (
            <div className="space-y-3">
              {(recent as AuditRecord[]).slice(0, 5).map((record) => (
                <div key={record.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                  <div className="flex items-center gap-4 min-w-0">
                    <ModuleBadge module={record.module} />
                    <span className="text-sm text-slate-600 truncate">{record.recommended_action}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <Badge tone={record.policy_decision === 'approved' ? 'green' : 'red'}>
                      {record.policy_decision}
                    </Badge>
                    {record.human_escalation && <Badge tone="orange">ESCALATED</Badge>}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-slate-500 text-sm">No decisions yet. Run a simulation to see results.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
