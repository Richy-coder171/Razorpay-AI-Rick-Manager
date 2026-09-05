import { useState } from 'react';
import { simulateFraudSpike, simulateNormal, simulateDetectorFailure } from '../services/api';
import type { DemoResponse } from '../services/api';
import type { FraudSpikeResult } from '@risk-manager/shared';
import { PageHeader, Card, CardHeader, Badge, Button, RiskMeter } from '../components/ui';
import { PulseIcon, CheckIcon, AlertIcon } from '../components/icons';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';

interface ChartPoint {
  i: number;
  volume: number | null; // real window transaction count; null = this window (current)
  isCurrent: boolean;
}

export default function FraudMonitor() {
  const [result, setResult] = useState<DemoResponse | null>(null);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSimulate = async (type: 'normal' | 'fraud' | 'failure') => {
    setLoading(true);
    try {
      let data: DemoResponse;
      switch (type) {
        case 'normal':
          data = await simulateNormal();
          break;
        case 'fraud':
          data = await simulateFraudSpike();
          break;
        default:
          data = await simulateDetectorFailure();
          break;
      }
      setResult(data);
      buildChart(data);
    } catch (error) {
      console.error('Simulation failed:', error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Volume-over-time chart built ONLY from real detector data:
   * baseline.trailing_counts (the actual trailing window counts, chronological)
   * plus the current window as the final point. Nothing is synthesized or
   * backfilled — if the history is short, fewer real points are plotted.
   */
  const buildChart = (data: DemoResponse) => {
    const detector = data.detector as FraudSpikeResult | undefined;
    if (!detector || detector.failure_state) {
      setChartData([]);
      return;
    }
    const meta = data.demo_meta as { transactions?: number } | undefined;
    const currentCount = meta?.transactions ?? detector.affected_transaction_ids.length;
    const trailing = detector.baseline.trailing_counts ?? [];

    const points: ChartPoint[] = trailing.map((count, i) => ({
      i,
      volume: count,
      isCurrent: false,
    }));
    points.push({ i: trailing.length, volume: currentCount, isCurrent: true });
    setChartData(points);
  };

  const detector = result?.detector as FraudSpikeResult | undefined;
  const agent = result?.agent;
  const policy = result?.policy;
  const calibrationSource =
    (detector as (FraudSpikeResult & { calibration_source?: string }) | undefined)?.calibration_source;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fraud Spike Monitor"
        subtitle="10-minute transaction windows against a trailing 30-window baseline"
        badge={<Badge tone="blue">Primary module</Badge>}
        actions={
          <>
            <Button variant="success" onClick={() => handleSimulate('normal')} disabled={loading}>Simulate Normal Traffic</Button>
            <Button variant="danger" onClick={() => handleSimulate('fraud')} disabled={loading}>Simulate Fraud Spike</Button>
            <Button variant="secondary" onClick={() => handleSimulate('failure')} disabled={loading}>Simulate Detector Failure</Button>
          </>
        }
      />

      {loading && (
        <Card className="p-8 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-600 mx-auto"></div>
          <p className="mt-4 text-slate-600">Running detection pipeline...</p>
        </Card>
      )}

      {result && !loading && (
        <div className="space-y-6">
          {chartData.length === 0 ? (
            <Card className="p-6">
              <div className="flex items-center gap-3 text-slate-600">
                <AlertIcon className="h-5 w-5" />
                <span className="text-sm">
                  No window history to chart — the detector reported{' '}
                  {detector?.failure_state ?? 'insufficient_data'}, so there are no real trailing windows to plot.
                  Nothing is synthesized on this chart.
                </span>
              </div>
            </Card>
          ) : detector?.failure_state ? (
            <Card className="p-5">
              <div className="flex items-center gap-3 text-red-700">
                <AlertIcon className="h-5 w-5" />
                <span className="text-sm font-medium">
                  Detector failure ({detector.failure_state}) — the AI refused to guess; escalated to a human.
                </span>
              </div>
            </Card>
          ) : (
            <Card>
              <CardHeader
                title="Transaction Volume — Real Trailing Windows"
                subtitle={`${chartData.length - 1} actual baseline windows (chronological) + the current window last. No synthesized points.`}
                icon={<PulseIcon className="h-5 w-5" />}
              />
              <div className="px-6 pb-6 h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="i" tick={false} label={{ value: 'windows →', position: 'insideBottomRight', offset: -2 }} />
                    <YAxis allowDecimals={false} width={48} />
                    <Tooltip
                      formatter={(value: number | string, _name, item) => [
                        value,
                        (item?.payload as ChartPoint | undefined)?.isCurrent ? 'Current window' : 'Trailing window',
                      ]}
                      labelFormatter={(label) =>
                        Number(label) === chartData.length - 1 ? 'Current window' : `Trailing window ${Number(label) + 1}`
                      }
                    />
                    <Legend
                      formatter={(value) => (value === 'volume' ? 'Transactions per 10-min window (real)' : value)}
                    />
                    <ReferenceLine x={chartData.length - 1.5} stroke="#94a3b8" strokeDasharray="4 4" label={{ value: 'now', fill: '#94a3b8', fontSize: 11 }} />
                    <Line
                      type="monotone"
                      dataKey="volume"
                      stroke="#2563eb"
                      strokeWidth={2}
                      dot={(props: { cx: number; cy: number; payload: ChartPoint }) => {
                        const { cx, cy, payload } = props;
                        if (payload.isCurrent) {
                          return <circle key="current" cx={cx} cy={cy} r={5} fill="#dc2626" stroke="#fff" strokeWidth={2} />;
                        }
                        return <circle key={`t-${payload.i}`} cx={cx} cy={cy} r={2} fill="#2563eb" opacity={0.5} />;
                      }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader title="Detector Output" icon={<PulseIcon className="h-5 w-5" />} />
              <div className="px-6 pb-6 space-y-3">
                {detector && !detector.failure_state ? (
                  <>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Transactions Analyzed:</span>
                      <span className="font-medium">{detector.affected_transaction_ids.length}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Is Spike:</span>
                      <Badge tone={detector.is_spike ? 'red' : 'green'}>{detector.is_spike ? 'YES' : 'NO'}</Badge>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Anomaly Score:</span>
                      <span className="font-medium tabular-nums">{detector.anomaly_score}</span>
                    </div>
                    <RiskMeter value={detector.calibrated_probability} label="Calibrated probability" />
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Baseline Mean / Std:</span>
                      <span className="font-medium tabular-nums">{detector.baseline.mean} / {detector.baseline.std}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Calibration Source:</span>
                      <Badge tone={calibrationSource === 'fitted' ? 'green' : 'yellow'}>
                        {calibrationSource === 'fitted' ? 'Fitted (evaluation)' : calibrationSource ?? 'bootstrap_default'}
                      </Badge>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-slate-500">
                    No detector output — failure state: {detector?.failure_state ?? 'unknown'}
                  </p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="AI Risk Manager Decision" icon={<CheckIcon className="h-5 w-5" />} />
              <div className="px-6 pb-6 space-y-3">
                {agent ? (
                  <>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Recommended Action:</span>
                      <span className="font-medium text-brand-700">{agent.recommended_action}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Confidence:</span>
                      <Badge tone={agent.confidence === 'high' ? 'green' : agent.confidence === 'medium' ? 'orange' : 'red'}>
                        {agent.confidence}
                      </Badge>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Escalate to Human:</span>
                      <Badge tone={agent.escalate_to_human ? 'orange' : 'green'}>
                        {agent.escalate_to_human ? 'YES' : 'NO'}
                      </Badge>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-slate-500">No agent output.</p>
                )}
              </div>
            </Card>
          </div>

          {agent && (
            <Card>
              <CardHeader title="Explanation" />
              <div className="px-6 pb-6">
                <p className="text-slate-700 text-sm leading-relaxed">{agent.explanation}</p>
              </div>
            </Card>
          )}

          {policy && (
            <Card>
              <CardHeader title="Policy Decision" />
              <div className="px-6 pb-6 flex items-center gap-4">
                <Badge tone={policy.approved ? 'green' : 'red'}>
                  {policy.decision.toUpperCase()}
                </Badge>
                <span className="text-slate-600 text-sm">Reason: {policy.reason}</span>
              </div>
            </Card>
          )}

          {agent && agent.evidence_cited.length > 0 && (
            <Card>
              <CardHeader title="Evidence Cited" subtitle="Every id must exist in the detector output (Guard-enforced)" />
              <div className="px-6 pb-6 flex flex-wrap gap-2">
                {agent.evidence_cited.map((evidence, idx) => (
                  <span key={idx} className="px-3 py-1 bg-brand-50 text-brand-700 rounded-full text-sm">
                    {evidence}
                  </span>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
