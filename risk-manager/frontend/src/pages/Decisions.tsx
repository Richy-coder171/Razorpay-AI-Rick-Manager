import { useState, useEffect } from 'react';
import { fetchAuditLog } from '../services/api';
import type { AuditRecord } from '@risk-manager/shared';
import { PageHeader, Card, Badge, ModuleBadge, ConfidenceBadge, Button } from '../components/ui';
import { RefreshIcon } from '../components/icons';

export default function Decisions() {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRecords();
  }, []);

  const loadRecords = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAuditLog({ limit: 50 });
      setRecords(data.records || []);
    } catch (err) {
      setError((err as Error).message);
      console.error('Failed to load records:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Risk Decisions"
        subtitle="Every pipeline run, from the hash-chained audit log"
        actions={<Button variant="secondary" onClick={loadRecords}><RefreshIcon className="h-4 w-4" /> Refresh</Button>}
      />

      {loading ? (
        <Card className="p-8 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-600 mx-auto"></div>
        </Card>
      ) : error ? (
        <Card className="p-8 text-center text-red-600 text-sm">{error}</Card>
      ) : records.length === 0 ? (
        <Card className="p-8 text-center text-slate-500">No decisions yet. Run a simulation to see results.</Card>
      ) : (
        <div className="space-y-4">
          {records.map((record) => (
            <Card key={record.id} className="p-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <ModuleBadge module={record.module} />
                  <span className="text-sm text-slate-500">{new Date(record.timestamp).toLocaleString()}</span>
                </div>
                {record.human_escalation && <Badge tone="orange">ESCALATED TO HUMAN</Badge>}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
                <div>
                  <div className="text-xs text-slate-500">Detector</div>
                  <div className="text-sm font-medium">{record.detector}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Action</div>
                  <div className="text-sm font-medium text-brand-700">{record.recommended_action}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Confidence</div>
                  <ConfidenceBadge confidence={record.confidence} />
                </div>
                <div>
                  <div className="text-xs text-slate-500">Policy</div>
                  <Badge tone={record.policy_decision === 'approved' ? 'green' : 'red'}>
                    {record.policy_decision}
                  </Badge>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-xs text-slate-500">Evidence:</span>
                {record.evidence_cited.length > 0 ? (
                  record.evidence_cited.map((evidence, idx) => (
                    <span key={idx} className="px-2 py-0.5 bg-brand-50 text-brand-700 rounded-full text-xs">
                      {evidence}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-slate-400">none</span>
                )}
              </div>

              {record.failure_state && (
                <div className="mt-4 p-3 bg-red-50 rounded-lg ring-1 ring-red-200">
                  <span className="text-xs text-red-800 font-medium">Failure State: {record.failure_state}</span>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
