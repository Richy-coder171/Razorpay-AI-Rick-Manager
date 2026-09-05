import { AuditRecord } from '../types';
import { v4 as uuidv4 } from 'uuid';

export class AuditLogger {
  private records: AuditRecord[] = [];

  log(record: Omit<AuditRecord, 'id' | 'timestamp'>): AuditRecord {
    const fullRecord: AuditRecord = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      ...record,
    };
    this.records.push(fullRecord);
    return fullRecord;
  }

  getRecords(filters?: {
    module?: string;
    action?: string;
    confidence?: string;
    escalated?: boolean;
    startDate?: string;
    endDate?: string;
  }): AuditRecord[] {
    let filtered = [...this.records];

    if (filters?.module) {
      filtered = filtered.filter((r) => r.module === filters.module);
    }
    if (filters?.action) {
      filtered = filtered.filter((r) => r.recommended_action === filters.action);
    }
    if (filters?.confidence) {
      filtered = filtered.filter((r) => r.confidence === filters.confidence);
    }
    if (filters?.escalated !== undefined) {
      filtered = filtered.filter((r) => r.human_escalation === filters.escalated);
    }
    if (filters?.startDate) {
      filtered = filtered.filter((r) => r.timestamp >= filters.startDate!);
    }
    if (filters?.endDate) {
      filtered = filtered.filter((r) => r.timestamp <= filters.endDate!);
    }

    return filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  getRecordById(id: string): AuditRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  getStats(): {
    total: number;
    byModule: Record<string, number>;
    escalated: number;
    approved: number;
    rejected: number;
  } {
    const byModule: Record<string, number> = {};
    let escalated = 0;
    let approved = 0;
    let rejected = 0;

    for (const record of this.records) {
      byModule[record.module] = (byModule[record.module] || 0) + 1;
      if (record.human_escalation) escalated++;
      if (record.policy_decision === 'approved') approved++;
      if (record.policy_decision === 'rejected') rejected++;
    }

    return {
      total: this.records.length,
      byModule,
      escalated,
      approved,
      rejected,
    };
  }
}

export const auditLogger = new AuditLogger();
