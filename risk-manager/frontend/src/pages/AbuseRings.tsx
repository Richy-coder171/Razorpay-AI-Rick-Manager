import { useState } from 'react';
import { simulateAbuseRing } from '../services/api';
import type { AbuseRingResult } from '@risk-manager/shared';
import type { DemoResponse } from '../services/api';
import { PageHeader, Card, CardHeader, Badge, Button, RiskMeter } from '../components/ui';
import ClusterGraph from '../components/ClusterGraph';

export default function AbuseRings() {
  const [result, setResult] = useState<DemoResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSimulate = async () => {
    setLoading(true);
    try {
      const data = await simulateAbuseRing();
      setResult(data);
    } catch (error) {
      console.error('Simulation failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const detector = result?.detector as AbuseRingResult | undefined;
  const agent = result?.agent;
  const policy = result?.policy;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Abuse Ring Detector"
        subtitle="Linked accounts as a cluster — investigation, not conviction"
        badge={<Badge tone="purple">Supporting module</Badge>}
        actions={<Button variant="purple" onClick={handleSimulate} disabled={loading}>Simulate Abuse Ring</Button>}
      />

      {loading && (
        <Card className="p-8 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-violet-600 mx-auto"></div>
          <p className="mt-4 text-slate-600">Analyzing account relationships...</p>
        </Card>
      )}

      {result && !loading && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader title="Ring Analysis" />
              <div className="px-6 pb-6 space-y-3">
                {detector ? (
                  <>
                    <RiskMeter value={detector.ring_score} label="Ring score" />
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Cluster ID:</span>
                      <span className="font-medium font-mono text-xs">{detector.cluster_id}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Cluster Size:</span>
                      <span className="font-medium">{detector.cluster_size} accounts</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Recommended Action:</span>
                      <span className="font-medium text-brand-700">{agent?.recommended_action}</span>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-slate-500">No detector output.</p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Cluster Members" />
              <div className="px-6 pb-6 space-y-2">
                {detector && detector.member_account_ids.length > 0 ? (
                  detector.member_account_ids.map((id) => (
                    <div key={id} className="p-2 bg-slate-50 rounded text-sm font-mono">{id}</div>
                  ))
                ) : (
                  <p className="text-slate-500 text-sm">No cluster members.</p>
                )}
              </div>
            </Card>
          </div>

          {detector && !detector.failure_state && (
            <Card>
              <CardHeader
                title="Cluster Graph"
                subtitle="Accounts (circles) linked through shared attributes (diamonds) — the actual union-find graph the detector walks"
              />
              <div className="pt-2">
                <ClusterGraph
                  memberAccountIds={detector.member_account_ids}
                  sharedAttributes={detector.shared_attributes ?? []}
                  anchorAccountId={detector.anchor_account_id}
                />
              </div>
            </Card>
          )}

          {detector && (
            <Card>
              <CardHeader title="Connecting Signals" />
              <div className="px-6 pb-6 flex flex-wrap gap-2">
                {detector.connecting_signals.length > 0 ? (
                  detector.connecting_signals.map((signal, idx) => (
                    <span key={idx} className="px-3 py-1 bg-violet-50 text-violet-700 rounded-full text-sm ring-1 ring-violet-200">
                      {signal.replace('shared_', 'shared ')}
                    </span>
                  ))
                ) : (
                  <span className="text-slate-500">No connecting signals found</span>
                )}
              </div>
            </Card>
          )}

          {agent && (
            <Card>
              <CardHeader title="AI Explanation" />
              <div className="px-6 pb-6">
                <p className="text-slate-700 text-sm leading-relaxed">{agent.explanation}</p>
              </div>
            </Card>
          )}

          {policy && (
            <Card>
              <CardHeader title="Policy Decision" />
              <div className="px-6 pb-6 flex items-center gap-4">
                <Badge tone={policy.approved ? 'green' : 'red'}>{policy.decision.toUpperCase()}</Badge>
                <span className="text-slate-600 text-sm">Reason: {policy.reason}</span>
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="Important Note" />
            <div className="px-6 pb-6">
              <p className="text-sm text-slate-600 bg-amber-50 p-4 rounded-lg ring-1 ring-amber-200">
                A suspicious cluster is NOT automatically proof of fraud. The recommended action is investigation,
                not conviction. Permanent bans are never automated — the action vocabulary has no ban variant by
                construction.
              </p>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
