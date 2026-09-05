import { Transaction } from '../types';

export interface FeatureVector {
  count: number;
  totalAmount: number;
  meanAmount: number;
  stdAmount: number;
  uniqueCustomers: number;
  uniqueCards: number;
  uniqueDevices: number;
  failureRate: number;
  velocity: number;
}

export function extractTransactionFeatures(transactions: Transaction[]): FeatureVector {
  const amounts = transactions.map((t) => t.amount);
  const customers = new Set(transactions.map((t) => t.customer_id));
  const cards = new Set(transactions.filter((t) => t.card_hash).map((t) => t.card_hash));
  const devices = new Set(
    transactions.filter((t) => t.device_fingerprint).map((t) => t.device_fingerprint)
  );
  const failedCount = transactions.filter((t) => t.status === 'failed').length;

  return {
    count: transactions.length,
    totalAmount: amounts.reduce((a, b) => a + b, 0),
    meanAmount: amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0,
    stdAmount: calculateStd(amounts),
    uniqueCustomers: customers.size,
    uniqueCards: cards.size,
    uniqueDevices: devices.size,
    failureRate: transactions.length > 0 ? failedCount / transactions.length : 0,
    velocity: transactions.length,
  };
}

function calculateStd(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(variance);
}
