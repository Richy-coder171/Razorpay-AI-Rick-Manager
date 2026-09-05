import type {
  PipelineResponse,
  AuditRecord,
  EvaluationMetrics,
  EvaluationNotFound,
  DashboardStats,
  PolicyConfig,
} from '@risk-manager/shared';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const API_KEY = import.meta.env.VITE_DEMO_API_KEY || 'demo-key';

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'x-api-key': API_KEY,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
}

export type AuditListResponse = { records: AuditRecord[]; total: number };
export type EvaluationResponse = EvaluationMetrics | EvaluationNotFound;
export type DashboardResponse = DashboardStats & {
  provider_mode: { provider: string; mode: string; live: boolean };
  db_driver: string;
};
export type DemoResponse = PipelineResponse & { demo_meta?: unknown };

export async function fetchHealth() {
  const response = await apiFetch('/health');
  return response.json();
}

export async function fetchDashboard(): Promise<DashboardResponse> {
  const response = await apiFetch('/dashboard');
  if (!response.ok) throw new Error(`dashboard failed: ${response.status}`);
  return response.json();
}

export async function fetchPolicyConfig(): Promise<PolicyConfig> {
  const response = await apiFetch('/policy/config');
  if (!response.ok) throw new Error(`policy config failed: ${response.status}`);
  return response.json();
}

// Demo scenario names must match the backend SCENARIOS list exactly
// (backend/src/routes/demo.ts): snake_case values.
export async function simulateNormal(): Promise<DemoResponse> {
  const response = await apiFetch('/demo/simulate/normal_traffic', { method: 'POST' });
  if (!response.ok) throw new Error(`simulation failed: ${response.status}`);
  return response.json();
}

export async function simulateFraudSpike(): Promise<DemoResponse> {
  const response = await apiFetch('/demo/simulate/fraud_spike', { method: 'POST' });
  if (!response.ok) throw new Error(`simulation failed: ${response.status}`);
  return response.json();
}

export async function simulateReturnRisk(): Promise<DemoResponse> {
  const response = await apiFetch('/demo/simulate/return_risk', { method: 'POST' });
  if (!response.ok) throw new Error(`simulation failed: ${response.status}`);
  return response.json();
}

export async function simulateAbuseRing(): Promise<DemoResponse> {
  const response = await apiFetch('/demo/simulate/abuse_ring', { method: 'POST' });
  if (!response.ok) throw new Error(`simulation failed: ${response.status}`);
  return response.json();
}

export async function simulateChargeback(): Promise<DemoResponse> {
  const response = await apiFetch('/demo/simulate/chargeback', { method: 'POST' });
  if (!response.ok) throw new Error(`simulation failed: ${response.status}`);
  return response.json();
}

export async function simulateDetectorFailure(): Promise<DemoResponse> {
  const response = await apiFetch('/demo/simulate/detector_failure', { method: 'POST' });
  if (!response.ok) throw new Error(`simulation failed: ${response.status}`);
  return response.json();
}

export async function simulateInvalidData(): Promise<DemoResponse> {
  const response = await apiFetch('/demo/simulate/invalid_data', { method: 'POST' });
  if (!response.ok) throw new Error(`simulation failed: ${response.status}`);
  return response.json();
}

export async function simulateActionTimeout(): Promise<DemoResponse> {
  const response = await apiFetch('/demo/simulate/payment_timeout', { method: 'POST' });
  if (!response.ok) throw new Error(`simulation failed: ${response.status}`);
  return response.json();
}

export async function fetchAuditLog(params?: {
  module?: string;
  confidence?: string;
  escalated?: boolean;
  limit?: number;
}): Promise<AuditListResponse> {
  const query = new URLSearchParams();
  if (params?.module) query.set('module', params.module);
  if (params?.confidence) query.set('confidence', params.confidence);
  if (params?.escalated !== undefined) query.set('escalated', String(params.escalated));
  if (params?.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  const response = await apiFetch(`/audit${qs ? `?${qs}` : ''}`);
  if (!response.ok) throw new Error(`audit fetch failed: ${response.status}`);
  return response.json();
}

export async function fetchAuditStats() {
  const response = await apiFetch('/audit/stats');
  if (!response.ok) throw new Error(`audit stats failed: ${response.status}`);
  return response.json();
}

export async function fetchEvaluation(): Promise<EvaluationResponse> {
  const response = await apiFetch('/evaluation/fraud-spike');
  if (!response.ok) throw new Error(`evaluation fetch failed: ${response.status}`);
  return response.json();
}

// --- Real Razorpay Test Checkout (₹100) ---

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  key_id: string;
  test_mode: boolean;
}

export async function createTestOrder(): Promise<RazorpayOrder> {
  const response = await apiFetch('/razorpay/order', { method: 'POST' });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `order creation failed: ${response.status}`);
  return body as unknown as RazorpayOrder;
}

export interface VerifiedPaymentInfo {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: 'captured' | 'failed';
  created_at: string;
  raw_event: string;
}

export async function fetchVerifiedPayments(): Promise<VerifiedPaymentInfo[]> {
  const response = await apiFetch('/razorpay/payments');
  if (!response.ok) throw new Error(`payments fetch failed: ${response.status}`);
  const body = (await response.json()) as { payments: VerifiedPaymentInfo[] };
  return body.payments ?? [];
}

/** Verify the checkout callback signature via the backend (real HMAC with the key secret). */
export async function verifyCheckoutSignature(
  orderId: string,
  paymentId: string,
  signature: string
): Promise<{ verified: boolean; provider: string; mode: string }> {
  const response = await apiFetch('/webhooks/razorpay/verify-payment', {
    method: 'POST',
    body: JSON.stringify({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    }),
  });
  if (!response.ok) throw new Error(`verify failed: ${response.status}`);
  return response.json();
}
