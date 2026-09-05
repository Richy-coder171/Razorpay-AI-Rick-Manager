/**
 * Audit Log v2 (§16) — append-only, hash-chained.
 *
 * hash = sha256(prev_hash + stable_stringify(record_without_hash))
 * Each record stores the previous record's hash, so tampering with history is
 * DETECTABLE, not just discouraged. No update/delete route exists at all.
 */

import { AuditRecord } from '../types';
import { IRepository } from '../models/repository';
import { sha256Hex, stableStringify, nowIso } from '../utils/crypto';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';

export type AuditEntry = Omit<AuditRecord, 'id' | 'timestamp' | 'prev_hash' | 'hash'>;

export const GENESIS_HASH = '0'.repeat(64);

export class AuditService {
  constructor(private repo: IRepository<AuditRecord>) {}

  /** Append a chained record. This is the ONLY write operation. */
  async log(entry: AuditEntry): Promise<AuditRecord> {
    const last = await this.getLast();
    const prevHash = last ? last.hash : GENESIS_HASH;

    const record: AuditRecord = {
      id: uuidv4(),
      timestamp: nowIso(),
      seq: last && last.seq !== undefined ? last.seq + 1 : 1,
      ...entry,
      prev_hash: prevHash,
      hash: '', // computed below
    };

    record.hash = this.computeHash(record);
    await this.repo.insert(record);
    logger.debug({ audit_id: record.id, hash: record.hash.slice(0, 12) }, 'audit record appended');
    return record;
  }

  computeHash(record: AuditRecord): string {
    const { hash: _hash, ...withoutHash } = record;
    // Exclude storage-internal keys (Mongo's _id) — the chain must hash the
    // RECORD's own fields only, so verification succeeds across drivers.
    const { _id: _mongoId, ...canonical } = withoutHash as AuditRecord & { _id?: unknown };
    return sha256Hex(record.prev_hash + stableStringify(canonical));
  }

  async getRecords(filters?: {
    module?: string;
    action?: string;
    confidence?: string;
    escalated?: boolean;
    failure_state?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<AuditRecord[]> {
    let records = await this.repo.findAll();
    if (filters?.module) records = records.filter((r) => r.module === filters.module);
    if (filters?.action) records = records.filter((r) => r.recommended_action === filters.action);
    if (filters?.confidence) records = records.filter((r) => r.confidence === filters.confidence);
    if (filters?.escalated !== undefined) records = records.filter((r) => r.human_escalation === filters.escalated);
    if (filters?.failure_state) records = records.filter((r) => r.failure_state === filters.failure_state);
    if (filters?.startDate) records = records.filter((r) => r.timestamp >= filters.startDate!);
    if (filters?.endDate) records = records.filter((r) => r.timestamp <= filters.endDate!);
    if (filters?.limit && filters.limit > 0) records = records.slice(0, filters.limit);
    return records;
  }

  async getRecordById(id: string): Promise<AuditRecord | null> {
    return this.repo.findById(id);
  }

  async getLast(): Promise<AuditRecord | null> {
    const all = await this.repo.findAll();
    // findAll returns newest-first for file repo; find max timestamp to be safe.
    if (all.length === 0) return null;
    return all.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b));
  }

  /**
   * Walk the chain and verify: (a) every record's hash matches its content,
   * (b) prev_hash links are intact. Returns detailed verification output —
   * run this live for judges (`npm run verify-audit` or GET /api/audit/verify).
   */
  async verifyChain(): Promise<{
    valid: boolean;
    records_checked: number;
    broken_at?: string;
    reason?: string;
  }> {
    const all = await this.repo.findAll();
    // chronological order by seq (monotonic), falling back to timestamp/id.
    const ordered = [...all].sort((a, b) =>
      a.seq !== undefined && b.seq !== undefined
        ? a.seq - b.seq
        : a.timestamp < b.timestamp
          ? -1
          : a.timestamp > b.timestamp
            ? 1
            : a.id < b.id
              ? -1
              : 1
    );

    let prevHash = GENESIS_HASH;
    for (const record of ordered) {
      if (record.prev_hash !== prevHash) {
        return {
          valid: false,
          records_checked: ordered.indexOf(record),
          broken_at: record.id,
          reason: `prev_hash mismatch at record ${record.id}: expected ${prevHash.slice(0, 12)}…, found ${record.prev_hash.slice(0, 12)}…`,
        };
      }
      const expected = this.computeHash(record);
      if (expected !== record.hash) {
        return {
          valid: false,
          records_checked: ordered.indexOf(record),
          broken_at: record.id,
          reason: `content hash mismatch at record ${record.id}: record was modified after writing`,
        };
      }
      prevHash = record.hash;
    }

    return { valid: true, records_checked: ordered.length };
  }

  async stats(): Promise<{
    total: number;
    by_module: Record<string, number>;
    escalated: number;
    approved: number;
    escalated_to_approved: number;
    guard_rejections: number;
    failures: number;
  }> {
    const all = await this.repo.findAll();
    const byModule: Record<string, number> = {};
    let escalated = 0;
    let approved = 0;
    let both = 0;
    let guardRejections = 0;
    let failures = 0;

    for (const r of all) {
      byModule[r.module] = (byModule[r.module] || 0) + 1;
      if (r.human_escalation) escalated++;
      if (r.policy_decision === 'approved') approved++;
      if (r.human_escalation && r.policy_decision === 'approved') both++;
      if (r.failure_state === 'agent_output_rejected') guardRejections++;
      if (r.failure_state) failures++;
    }

    return {
      total: all.length,
      by_module: byModule,
      escalated,
      approved,
      escalated_to_approved: both,
      guard_rejections: guardRejections,
      failures,
    };
  }
}
