/**
 * Bridge for POST /api/agent/decision: converts a generic {module, ...payload}
 * into the typed RiskEvent the pipeline expects. Zod validation happens per
 * module using the same schemas as the dedicated routes.
 */

import { z } from 'zod';
import { RiskEvent } from './riskPipeline';
import { Transaction, Order, LinkedAccount, Dispute } from '../types';
import { WindowFeatures } from '../features';

const transactionSchema = z.object({
  id: z.string().min(1),
  merchant_id: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().default('INR'),
  status: z.enum(['captured', 'failed', 'pending']),
  payment_mode: z.enum(['cod', 'prepaid']),
  customer_id: z.string().min(1),
  card_hash: z.string().optional(),
  device_fingerprint: z.string().optional(),
  ip_hash: z.string().optional(),
  region: z.string().optional(),
  created_at: z.string().min(1),
});

const orderSchema = z.object({
  order_id: z.string().min(1),
  merchant_id: z.string().min(1),
  customer_id: z.string().min(1),
  order_value: z.number().positive(),
  payment_mode: z.enum(['cod', 'prepaid']),
  delivery_address: z.object({
    serviceability: z.enum(['high', 'medium', 'low']),
    city: z.string(),
    state: z.string(),
    pincode: z.string(),
  }),
  customer_history: z.object({
    prior_returns: z.number().int().min(0),
    failed_deliveries: z.number().int().min(0),
    total_orders: z.number().int().min(0),
    account_age_days: z.number().int().min(0),
    similar_past_orders: z.array(z.object({ order_id: z.string(), outcome: z.enum(['delivered', 'returned', 'failed']) })).default([]),
  }),
  created_at: z.string().optional(),
  status: z.enum(['pending', 'delivered', 'returned', 'failed']).optional(),
});

const accountSchema = z.object({
  account_id: z.string().min(1),
  shared_device_hash: z.string().optional(),
  shared_phone_hash: z.string().optional(),
  shared_email_hash: z.string().optional(),
  shared_address_hash: z.string().optional(),
  shared_payment_identifier: z.string().optional(),
  shared_ip_hash: z.string().optional(),
  chargeback_count: z.number().int().min(0).optional(),
});

const disputeSchema = z.object({
  dispute_id: z.string().min(1),
  merchant_id: z.string().min(1),
  reason_code: z.string().min(1),
  amount: z.number().positive(),
  respond_by: z.string().min(1),
  available_evidence: z.array(z.string()).default([]),
});

export function buildAgentDecisionEvent(module: string, payload: Record<string, unknown>): RiskEvent {
  switch (module) {
    case 'fraud_spike': {
      const parsed = z
        .object({
          merchant_id: z.string().optional(),
          window_start: z.string().optional(),
          window_end: z.string().optional(),
          transactions: z.array(transactionSchema).min(1),
          prior_window_features: z.array(z.record(z.unknown())).optional(),
        })
        .safeParse(payload);
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const txns = parsed.data.transactions as Transaction[];
      return {
        module: 'fraud_spike',
        merchant_id: parsed.data.merchant_id || txns[0].merchant_id,
        window: txns,
        prior_window_features: (parsed.data.prior_window_features as unknown as WindowFeatures[]) || [],
        window_start: parsed.data.window_start,
        window_end: parsed.data.window_end,
      };
    }
    case 'return_risk': {
      const parsed = orderSchema.safeParse(payload);
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const order = { ...parsed.data, created_at: parsed.data.created_at || new Date().toISOString(), status: parsed.data.status || 'pending' } as Order;
      return { module: 'return_risk', merchant_id: order.merchant_id, order };
    }
    case 'abuse_ring': {
      const parsed = z
        .object({ merchant_id: z.string().min(1), anchor_account_id: z.string().min(1), accounts: z.array(accountSchema).min(1) })
        .safeParse(payload);
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return {
        module: 'abuse_ring',
        merchant_id: parsed.data.merchant_id,
        accounts: parsed.data.accounts as LinkedAccount[],
        anchor_account_id: parsed.data.anchor_account_id,
      };
    }
    case 'chargeback': {
      const parsed = disputeSchema.safeParse(payload);
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return { module: 'chargeback', merchant_id: parsed.data.merchant_id, dispute: parsed.data as unknown as Dispute };
    }
    default:
      throw new Error(`unknown module: ${module}`);
  }
}
