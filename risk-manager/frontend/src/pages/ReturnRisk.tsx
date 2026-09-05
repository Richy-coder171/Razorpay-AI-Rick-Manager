import { useState } from 'react';
import { simulateReturnRisk } from '../services/api';
import type { ReturnRiskResult } from '@risk-manager/shared';
import type { DemoResponse } from '../services/api';
import { PageHeader, Card, CardHeader, Badge, Button, RiskMeter } from '../components/ui';



export default function ReturnRisk() {
  const [result, setResult] = useState<DemoResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSimulate = async () => {
    setLoading(true);
    try {
      const data = await simulateReturnRisk();
      setResult(data);
    } catch (error) {
      console.error('Simulation failed:', error);
    } finally {
      setLoading(false);
    }
  };

  // The demo response does not echo the order; reconstruct what the detector reports.
  const detector = result?.detector as ReturnRiskResult | undefined;
  const agent = result?.agent;
  const policy = result?.policy;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Return Risk Detector"
        subtitle="COD and return losses — explainable weighted scorecard"
        badge={<Badge tone="yellow">Supporting module</Badge>}
        actions={<Button variant="warning" onClick={handleSimulate} disabled={loading}>Simulate Return Risk</Button>}
      />

      {loading && (
        <Card className="p-8 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-amber-500 mx-auto"></div>
          <p className="mt-4 text-slate-600">Analyzing return risk...</p>
        </Card>
      )}

      {result && !loading && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader title="Assessment" />
              <div className="px-6 pb-6 space-y-3">
                {detector ? (
                  <>
                    <RiskMeter value={detector.calibrated_probability} label="Return probability" />
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Recommended Action:</span>
                      <span className="font-medium text-brand-700">{agent?.recommended_action}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Confidence:</span>
                      <Badge tone={detector.confidence === 'high' ? 'green' : detector.confidence === 'medium' ? 'orange' : 'red'}>
                        {detector.confidence}
                      </Badge>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-slate-500">No detector output.</p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Policy Decision" />
              <div className="px-6 pb-6 space-y-3">
                {policy ? (
                  <div className="flex items-center gap-4">
                    <Badge tone={policy.approved ? 'green' : 'red'}>{policy.decision.toUpperCase()}</Badge>
                    <span className="text-slate-600 text-sm">Reason: {policy.reason}</span>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">No policy result.</p>
                )}
              </div>
            </Card>
          </div>

          {detector && (
            <Card>
              <CardHeader title="Top Risk Factors" />
              <div className="px-6 pb-6 flex flex-wrap gap-2">
                {detector.top_risk_factors.length > 0 ? (
                  detector.top_risk_factors.map((factor, idx) => (
                    <span key={idx} className="px-3 py-1 bg-red-50 text-red-700 rounded-full text-sm ring-1 ring-red-200">
                      {factor}
                    </span>
                  ))
                ) : (
                  <span className="text-slate-500">No significant risk factors</span>
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

