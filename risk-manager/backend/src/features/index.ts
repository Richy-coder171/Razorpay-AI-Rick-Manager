/**
 * Feature Layer (§3): pure functions computing per-window features.
 * No side effects, no randomness, no external calls.
 */

import { Transaction } from '../types';

export interface WindowFeatures {
  transaction_count: number;
  velocity_per_minute: number;
  total_amount: number;
  average_amount: number;
  amount_variance: number;
  unique_customers: number;
  unique_payment_identifiers: number;
  failure_rate: number;
  geo_concentration_hhi: number; // Herfindahl index over regions (0..1]
  window_start?: string;
  window_end?: string;
}

const WINDOW_MS = 10 * 60 * 1000;

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function std(values: number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) * (v - m), 0) / values.length;
  return Math.sqrt(variance);
}

/** Herfindahl–Hirschman Index over categorical values; 1 = fully concentrated. */
export function hhi(values: string[]): number {
  if (values.length === 0) return 0;
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  return Object.values(counts).reduce((acc, c) => acc + (c / values.length) ** 2, 0);
}

export function extractWindowFeatures(
  transactions: Transaction[],
  windowStart?: string,
  windowEnd?: string,
  windowMs = WINDOW_MS
): WindowFeatures {
  const amounts = transactions.map((t) => t.amount);
  const customers = new Set(transactions.map((t) => t.customer_id));
  const paymentIds = new Set(
    transactions.map((t) => t.card_hash || t.device_fingerprint || t.id).filter(Boolean)
  );
  const failed = transactions.filter((t) => t.status === 'failed').length;
  const minutes = windowMs / 60000;

  return {
    transaction_count: transactions.length,
    velocity_per_minute: minutes > 0 ? transactions.length / minutes : 0,
    total_amount: amounts.reduce((a, b) => a + b, 0),
    average_amount: mean(amounts),
    amount_variance: std(amounts) ** 2,
    unique_customers: customers.size,
    unique_payment_identifiers: paymentIds.size,
    failure_rate: transactions.length > 0 ? failed / transactions.length : 0,
    geo_concentration_hhi: hhi(transactions.map((t) => t.region || 'unknown')),
    window_start: windowStart,
    window_end: windowEnd,
  };
}
