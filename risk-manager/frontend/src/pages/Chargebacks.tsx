import { useState } from 'react';
import { simulateChargeback } from '../services/api';
import type { ChargebackResult } from '@risk-manager/shared';
import type { DemoResponse } from '../services/api';
import { PageHeader, Card, CardHeader, Badge, Button, RiskMeter } from '../components/ui';

export default function Chargebacks() {
  const [result, setResult] = useState<DemoResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSimulate = async () => {
    setLoading(true);
    try {
      const data = await simulateChargeback();
      setResult(data);
    } catch (error) {
      console.error('Simulation failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const detector = result?.detector as ChargebackResult | undefined;
  const agent = result?.agent;
  const policy = result?.policy;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Chargeback Assessor"
        subtitle="Dispute win probability from reason-code base rates and evidence completeness"
        badge={<Badge tone="blue">Supporting module</Badge>}
        actions={<Button onClick={handleSimulate} disabled={loading}>Simulate Chargeback</Button>}
      />

      {loading && (
        <Card className="p-8 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-600 mx-auto"></div>
          <p className="mt-4 text-slate-600">Assessing chargeback dispute...</p>
        </Card>
      )}

      {result && !loading && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader title="Win Assessment" />
              <div className="px-6 pb-6 space-y-3">
                {detector ? (
                  <>
                    <RiskMeter value={detector.win_probability} label="Win probability" />
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Base Rate:</span>
                      <span className="font-medium">{(detector.reason_code_base_rate * 100).toFixed(1)}%</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Evidence Completeness:</span>
                      <span className="font-medium">{(detector.evidence_completeness * 100).toFixed(0)}%</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Days Until Deadline:</span>
                      <Badge tone={detector.days_until_deadline <= 2 ? 'red' : detector.days_until_deadline <= 5 ? 'orange' : 'green'}>
                        {detector.days_until_deadline} days
                      </Badge>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-slate-500">No detector output.</p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Decision" />
              <div className="px-6 pb-6 space-y-3">
                {agent && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-500">Recommended Action:</span>
                    <span className="font-medium text-brand-700">{agent.recommended_action}</span>
                  </div>
                )}
                {policy && (
                  <div className="flex items-center gap-4">
                    <Badge tone={policy.approved ? 'green' : 'red'}>{policy.decision.toUpperCase()}</Badge>
                    <span className="text-slate-600 text-sm">Reason: {policy.reason}</span>
                  </div>
                )}
              </div>
            </Card>
          </div>

          {detector && (
            <Card>
              <CardHeader title="Missing Evidence" subtitle="Computed by set difference — never an LLM guess" />
              <div className="px-6 pb-6 flex flex-wrap gap-2">
                {detector.missing_evidence_types.length > 0 ? (
                  detector.missing_evidence_types.map((evidence, idx) => (
                    <span key={idx} className="px-3 py-1 bg-red-50 text-red-700 rounded-full text-sm ring-1 ring-red-200">
                      {evidence}
                    </span>
                  ))
                ) : (
                  <span className="text-emerald-700 font-medium text-sm">All required evidence available</span>
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
        </div>
      )}
    </div>
  );
}
