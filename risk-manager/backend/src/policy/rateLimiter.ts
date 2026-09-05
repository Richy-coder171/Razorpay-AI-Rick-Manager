/**
 * Sliding-window rate limiter (§13.7): counts auto actions per merchant per
 * module per rolling hour. Pure data structure — no Redis dependency needed
 * for this scale; swap in a Redis-backed implementation for real deployments.
 */

import { ModuleName } from '../types';

interface ActionEvent {
  at: number; // epoch ms
}

export class RateLimiter {
  private events: Map<string, ActionEvent[]> = new Map();

  private key(merchantId: string, module: ModuleName): string {
    return `${merchantId}|${module}`;
  }

  record(merchantId: string, module: ModuleName, at = Date.now()): void {
    const k = this.key(merchantId, module);
    const list = this.events.get(k) || [];
    list.push({ at });
    this.events.set(k, list);
  }

  /** Count of auto actions in the trailing hour. */
  count(merchantId: string, module: ModuleName, windowMs = 3600_000, now = Date.now()): number {
    const k = this.key(merchantId, module);
    const list = (this.events.get(k) || []).filter((e) => now - e.at < windowMs);
    this.events.set(k, list); // prune lazily
    return list.length;
  }

  reset(): void {
    this.events.clear();
  }
}
