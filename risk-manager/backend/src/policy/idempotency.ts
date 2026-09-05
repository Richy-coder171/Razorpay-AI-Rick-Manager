/**
 * Idempotency (§13): idempotency_key = sha256(merchant_id + module + event_id
 * + action). A replayed request with the same key returns the cached result
 * instead of re-executing. For Razorpay webhooks the x-razorpay-event-id header
 * is mixed into the key so redelivered events are no-ops (§19).
 */

import { createHash } from 'crypto';
import { IRepository } from '../models/repository';

export interface IdempotencyRecord {
  id: string; // the key itself
  result: unknown;
  created_at: string;
}

export function computeIdempotencyKey(parts: {
  merchant_id: string;
  module: string;
  event_id: string;
  action: string;
}): string {
  const raw = `${parts.merchant_id}|${parts.module}|${parts.event_id}|${parts.action}`;
  return createHash('sha256').update(raw).digest('hex');
}

export class IdempotencyManager {
  constructor(private repo: IRepository<IdempotencyRecord>) {}

  /** Returns the cached result if this key was already executed. */
  async check(key: string): Promise<unknown | null> {
    const existing = await this.repo.findById(key);
    return existing ? existing.result : null;
  }

  async store(key: string, result: unknown): Promise<void> {
    try {
      await this.repo.insert({ id: key, result, created_at: new Date().toISOString() });
    } catch {
      // duplicate insert => another worker stored it first; that's fine
    }
  }
}
