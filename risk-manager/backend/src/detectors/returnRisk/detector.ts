/**
 * Return Risk Detector (§8, supporting module — exploratory evaluation only).
 * Explainable weighted scorecard; NOT the judged evaluation.
 */

import { Order, ReturnRiskResult, ConfidenceLevel } from '../../types';

export const RETURN_RISK_DETECTOR_VERSION = 'return-risk-v1';

interface FactorWeight {
  factor: string;
  weight: number;
  applies: (order: Order) => boolean;
}

const FACTORS: FactorWeight[] = [
  { factor: 'cod_payment', weight: 0.25, applies: (o) => o.payment_mode === 'cod' },
  { factor: 'high_order_value', weight: 0.15, applies: (o) => o.order_value >= 5000 },
  {
    factor: 'repeat_return_history',
    weight: 0.25,
    applies: (o) => o.customer_history.prior_returns >= 2,
  },
  {
    factor: 'prior_failed_delivery',
    weight: 0.12,
    applies: (o) => o.customer_history.failed_deliveries >= 1,
  },
  { factor: 'low_serviceability_address', weight: 0.10, applies: (o) => o.delivery_address.serviceability === 'low' },
  { factor: 'new_customer', weight: 0.08, applies: (o) => o.customer_history.total_orders < 3 },
  { factor: 'new_account', weight: 0.05, applies: (o) => o.customer_history.account_age_days < 30 },
];

function confidenceFromScore(p: number, ordersSeen: number): ConfidenceLevel {
  // Deterministic: thin history or mid-band -> low/medium (§7.4 pattern).
  if (ordersSeen < 3) return 'low';
  if (p >= 0.3 && p <= 0.7) return 'medium';
  return 'high';
}

export function scoreReturnRisk(order: Order): ReturnRiskResult {
  const base = 0.10;
  const applied = FACTORS.filter((f) => f.applies(order));
  const probability = Math.min(1, base + applied.reduce((acc, f) => acc + f.weight, 0));

  return {
    module: 'return_risk',
    detector_version: RETURN_RISK_DETECTOR_VERSION,
    merchant_id: order.merchant_id,
    calibrated_probability: round2(probability),
    confidence: confidenceFromScore(probability, order.customer_history.total_orders),
    failure_state: null,
    top_risk_factors: applied.sort((a, b) => b.weight - a.weight).slice(0, 3).map((f) => f.factor),
    similar_past_orders: order.customer_history.similar_past_orders || [],
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
