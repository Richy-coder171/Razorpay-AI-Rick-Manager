import { sha256Hex } from '../utils/crypto';
import type { AuditRecord } from '../types';

/** Recompute a record's hash the same way AuditService does. */
export function computeRecordHash(record: AuditRecord): string {
  const crypto = require('crypto');
  const { hash: _hash, ...withoutHash } = record;
  const stable = stableStringify(withoutHash);
  return sha256Hex(record.prev_hash + stable);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export { GENESIS_HASH } from './auditService';
