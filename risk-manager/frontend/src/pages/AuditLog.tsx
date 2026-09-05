import { useState, useEffect } from 'react';
import { fetchAuditLog } from '../services/api';
import type { AuditRecord } from '@risk-manager/shared';
import { PageHeader, Card, Badge, ModuleBadge, Button } from '../components/ui';
import { RefreshIcon } from '../components/icons';

const MODULES = ['', 'fraud_spike', 'return_risk', 'abuse_ring', 'chargeback'];
const CONFIDENCES = ['', 'high', 'medium', 'low'];

export default function AuditLog() {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({ module: '', confidence: '', escalated: '' });

  useEffect(() => {
    loadRecords();
  }, []);

  const loadRecords = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAuditLog({
        module: filters.module || undefined,
        confidence: filters.confidence || undefined,
        escalated: filters.escalated === '' ? undefined : filters.escalated === 'true',
        limit: 200,
      });
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
        title="Audit Log"
        subtitle="Append-only, hash-chained — every field is filterable server-side"
        actions={<Button variant="secondary" onClick={loadRecords}><RefreshIcon className="h-4 w-4" /> Refresh</Button>}
      />

      <Card className="p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Module</label>
            <select
              value={filters.module}
              onChange={(e) => setFilters({ ...filters, module: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            >
              {MODULES.map((m) => (
                <option key={m} value={m}>{m === '' ? 'All Modules' : m.replace('_', ' ')}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Confidence</label>
            <select
              value={filters.confidence}
              onChange={(e) => setFilters({ ...filters, confidence: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            >
              {CONFIDENCES.map((c) => (
                <option key={c} value={c}>{c === '' ? 'All Levels' : c}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Escalated</label>
            <select
              value={filters.escalated}
              onChange={(e) => setFilters({ ...filters, escalated: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            >
              <option value="">All</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>
          <div className="flex items-end gap-2">
            <Button variant="primary" onClick={loadRecords} className="flex-1">Apply Filters</Button>
            <Button
              variant="ghost"
              onClick={() => { setFilters({ module: '', confidence: '', escalated: '' }); }}
            >
              Clear
            </Button>
          </div>
        </div>
      </Card>

      {error ? (
        <Card className="p-8 text-center text-red-600 text-sm">{error}</Card>
      ) : loading ? (
        <Card className="p-8 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-600 mx-auto"></div>
        </Card>
      ) : records.length === 0 ? (
        <Card className="p-8 text-center text-slate-500">No audit records found.</Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">Timestamp</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">Module</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">Action</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">Confidence</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">Policy</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">Escalated</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-200">
              {records.map((record) => (
                <tr key={record.id} className="hover:bg-slate-50">
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                    {new Date(record.timestamp).toLocaleString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <ModuleBadge module={record.module} />
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                    {record.recommended_action}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <Badge tone={record.confidence === 'high' ? 'green' : record.confidence === 'medium' ? 'orange' : 'red'}>
                      {record.confidence}
                    </Badge>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <Badge tone={record.policy_decision === 'approved' ? 'green' : 'red'}>
                      {record.policy_decision}
                    </Badge>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    {record.human_escalation ? (
                      <span className="text-orange-600 font-medium">Yes</span>
                    ) : (
                      <span className="text-slate-500">No</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
