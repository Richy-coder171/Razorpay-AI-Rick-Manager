/**
 * Chargeback Assessor (§10, supporting module).
 * win_probability = reason_code_base_rate x (0.5 + 0.5 x evidence_completeness), clipped to [0,1].
 * Base rates come from historical SYNTHETIC outcomes; evidence completeness is
 * a set difference, never an LLM guess.
 */

import { Dispute, ChargebackResult, ConfidenceLevel } from '../../types';

export const CHARGEBACK_DETECTOR_VERSION = 'chargeback-v1';

const REQUIRED_BY_REASON: Record<string, string[]> = {
  product_not_received: ['proof_of_delivery', 'customer_communication', 'tracking_info'],
  service_not_provided: ['proof_of_service', 'customer_communication', 'service_agreement'],
  fraudulent: ['avs_match', 'device_fingerprint', 'delivery_confirmation', 'customer_ip'],
  duplicate: ['transaction_receipt', 'customer_communication', 'refund_proof'],
  not_as_described: ['product_description', 'return_policy', 'customer_communication'],
};

const BASE_RATES: Record<string, number> = {
  product_not_received: 0.46,
  service_not_provided: 0.42,
  fraudulent: 0.35,
  duplicate: 0.50,
  not_as_described: 0.38,
};

/** Evidence required per reason code — the single taxonomy the detector, policy config, and demo all share. */
export const REQUIRED_EVIDENCE_BY_REASON: Record<string, string[]> = REQUIRED_BY_REASON;

function daysUntilDeadline(respondBy: string): number {
  const deadline = new Date(respondBy).getTime();
  const diff = deadline - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

export function assessChargeback(dispute: Dispute): ChargebackResult {
  const required = REQUIRED_BY_REASON[dispute.reason_code] || ['proof_of_service'];
  const missing = required.filter((e) => !dispute.available_evidence.includes(e));
  const completeness = (required.length - missing.length) / Math.max(required.length, 1);
  const baseRate = BASE_RATES[dispute.reason_code] ?? 0.4;

  const winProbability = clamp01(baseRate * (0.5 + 0.5 * completeness));

  // Deterministic confidence: mid-band probabilities are uncertain; missing
  // evidence also drops confidence.
  let confidence: ConfidenceLevel;
  if (winProbability >= 0.3 && winProbability <= 0.7) confidence = 'medium';
  else confidence = 'high';
  if (missing.length > 0) confidence = confidence === 'high' ? 'medium' : 'low';

  return {
    module: 'chargeback',
    detector_version: CHARGEBACK_DETECTOR_VERSION,
    merchant_id: dispute.merchant_id,
    win_probability: round2(winProbability),
    calibrated_probability: round2(winProbability), // same quantity; chargebacks are supporting-only
    missing_evidence_types: missing,
    reason_code_base_rate: baseRate,
    evidence_completeness: round2(completeness),
    days_until_deadline: daysUntilDeadline(dispute.respond_by),
    confidence,
    failure_state: null,
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
