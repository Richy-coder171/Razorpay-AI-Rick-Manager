/**
 * Shared contracts — canonical, snake_case end-to-end.
 * Import order: actions -> core domain -> detector outputs -> agent -> policy -> audit -> evaluation -> api.
 * IMPORTANT: The abuse-ring action enum has NO "ban" variant. Shipping a permanent ban
 * fails type-checking by construction (see shared/types/actions.ts).
 */

export type ModuleName = 'fraud_spike' | 'return_risk' | 'abuse_ring' | 'chargeback';
export type ConfidenceLevel = 'low' | 'medium' | 'high';
export type FailureState =
  | 'detector_unavailable'
  | 'insufficient_data'
  | 'malformed_input'
  | 'llm_unavailable'
  | 'agent_output_rejected'
  | 'action_executor_timeout'
  | 'duplicate_event'
  | 'unknown_state'
  | null;

// ---------------------------------------------------------------------------
// Actions (§6) — the ONLY legal actions per module. No "ban" variant exists.
// ---------------------------------------------------------------------------
export type FraudSpikeAction = 'auto_block_window' | 'flag_for_review' | 'no_action';
export type ReturnRiskAction = 'allow_cod' | 'require_prepaid' | 'flag_for_manual_review' | 'block_order';
export type AbuseRingAction = 'flag_ring_for_investigation' | 'restrict_accounts_pending_review' | 'no_action';
export type ChargebackAction =
  | 'auto_contest_full'
  | 'auto_contest_partial'
  | 'draft_for_human_review'
  | 'recommend_accept_loss';

export type ModuleAction =
  | FraudSpikeAction
  | ReturnRiskAction
  | AbuseRingAction
  | ChargebackAction;

export const MODULE_ACTION_ALLOWLIST: Record<ModuleName, readonly string[]> = {
  fraud_spike: ['auto_block_window', 'flag_for_review', 'no_action'],
  return_risk: ['allow_cod', 'require_prepaid', 'flag_for_manual_review', 'block_order'],
  abuse_ring: ['flag_ring_for_investigation', 'restrict_accounts_pending_review', 'no_action'],
  chargeback: ['auto_contest_full', 'auto_contest_partial', 'draft_for_human_review', 'recommend_accept_loss'],
};

export const IRREVERSIBLE_ACTIONS: readonly string[] = [
  'auto_block_window',
  'block_order',
  'restrict_accounts_pending_review',
  'auto_contest_full',
  'recommend_accept_loss',
];

// ---------------------------------------------------------------------------
// Core domain
// ---------------------------------------------------------------------------
export interface Transaction {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: 'captured' | 'failed' | 'pending';
  payment_mode: 'cod' | 'prepaid';
  customer_id: string;
  card_hash?: string;
  device_fingerprint?: string;
  ip_hash?: string;
  region?: string;
  created_at: string;
}

export interface DeliveryAddress {
  serviceability: 'high' | 'medium' | 'low';
  city: string;
  state: string;
  pincode: string;
}

export interface SimilarOrder {
  order_id: string;
  outcome: 'delivered' | 'returned' | 'failed';
}

export interface CustomerHistory {
  prior_returns: number;
  failed_deliveries: number;
  total_orders: number;
  account_age_days: number;
  similar_past_orders: SimilarOrder[];
}

export interface Order {
  order_id: string;
  merchant_id: string;
  customer_id: string;
  order_value: number;
  payment_mode: 'cod' | 'prepaid';
  delivery_address: DeliveryAddress;
  customer_history: CustomerHistory;
  created_at: string;
  status: 'pending' | 'delivered' | 'returned' | 'failed';
}

export interface LinkedAccount {
  account_id: string;
  shared_device_hash?: string;
  shared_phone_hash?: string;
  shared_email_hash?: string;
  shared_address_hash?: string;
  shared_payment_identifier?: string;
  shared_ip_hash?: string;
  chargeback_count?: number;
}

export interface Dispute {
  dispute_id: string;
  merchant_id: string;
  reason_code: string;
  amount: number;
  respond_by: string;
  available_evidence: string[];
}

// ---------------------------------------------------------------------------
// Detector outputs (§6 DetectorOutputBase pattern)
// ---------------------------------------------------------------------------
export interface DetectorOutputBase {
  module: ModuleName;
  detector_version: string;
  merchant_id: string;
  calibrated_probability: number; // 0..1, from the detector, never from the LLM
  confidence: ConfidenceLevel;     // deterministic (§7.4); the LLM only echoes it
  failure_state?: FailureState;
}

export interface BaselineInfo {
  mean: number;
  std: number;
  window_type: string;
  sample_windows: number;
  /** Real per-window transaction counts, chronological order (most recent last), capped for display. */
  trailing_counts?: number[];
}

export interface FraudSpikeResult extends DetectorOutputBase {
  module: 'fraud_spike';
  is_spike: boolean;
  anomaly_score: number;
  calibrated_probability: number;
  affected_transaction_ids: string[];
  affected_transactions_value: number; // sum(amount) over the window — used for FP cost
  /** Which calibration the live detector ran: fitted (evaluation harness) or bootstrap default. */
  calibration_source?: 'fitted' | 'bootstrap_default';
  baseline: BaselineInfo;
}

export interface ReturnRiskResult extends DetectorOutputBase {
  module: 'return_risk';
  top_risk_factors: string[];
  similar_past_orders: SimilarOrder[];
}

export interface SharedAttributeInfo {
  /** Account id (must appear in member_account_ids). */
  account_id: string;
  /** Signal type: shared_device|shared_phone|shared_email|shared_address|shared_payment_identifier|shared_ip. */
  signal: string;
  /** Hashed attribute value the account shares (never raw PII). */
  value: string;
}

export interface AbuseRingResult extends DetectorOutputBase {
  module: 'abuse_ring';
  ring_score: number;
  cluster_id: string;
  cluster_size: number;
  connecting_signals: string[];
  member_account_ids: string[];
  edge_density: number;
  /** Anchor account the investigation request is about. */
  anchor_account_id?: string;
  /** Per-member shared attributes — the actual graph edges, for visualization. */
  shared_attributes?: SharedAttributeInfo[];
}

export interface ChargebackResult extends DetectorOutputBase {
  module: 'chargeback';
  win_probability: number;
  missing_evidence_types: string[];
  reason_code_base_rate: number;
  evidence_completeness: number;
  days_until_deadline: number;
}

export type AnyDetectorResult = FraudSpikeResult | ReturnRiskResult | AbuseRingResult | ChargebackResult;

// ---------------------------------------------------------------------------
// Agent output (§6 AgentOutput<TAction>)
// ---------------------------------------------------------------------------
export interface AgentOutput<TAction extends string = string> {
  module: ModuleName;
  tool_called: string;
  calibrated_probability: number | null; // must equal detector value when detector produced one
  recommended_action: TAction;
  confidence: ConfidenceLevel; // must equal the input confidence — Guard checks
  escalate_to_human: boolean;
  explanation: string;
  evidence_cited: string[]; // every id here must exist in the detector output given to the LLM
}

// ---------------------------------------------------------------------------
// Policy (§13)
// ---------------------------------------------------------------------------
export interface PolicyModuleConfig {
  escalation_band: [number, number];
  auto_action_threshold: number;
  require_confidence: ConfidenceLevel;
  allowed_actions: string[];
  irreversible_actions: string[];
  max_auto_actions_per_merchant_per_hour: number;
  /** Chargeback only: evidence required per dispute reason_code (from the detector's taxonomy). */
  required_evidence?: string[] | Record<string, string[]>;
}

export interface PolicyConfig {
  version: string;
  global_kill_switch: boolean;
  modules: Record<ModuleName, PolicyModuleConfig>;
}

export type PolicyDecisionOutcome = 'approved' | 'escalated' | 'rejected';

export interface PolicyResult {
  decision: PolicyDecisionOutcome;
  approved: boolean; // true only when outcome === 'approved'
  reason: string;
  checks_run: Array<{ check: string; passed: boolean; detail?: string }>;
}

// ---------------------------------------------------------------------------
// Audit (§16)
// ---------------------------------------------------------------------------
export interface AuditRecord {
  id: string;
  timestamp: string;
  seq?: number; // monotonic append order — stable chain verification
  merchant_id: string;
  module: string;
  detector: string;
  detector_version?: string;
  policy_version?: string;
  input_reference: string;
  event_id?: string;
  detector_output: unknown;
  recommended_action: string;
  policy_decision: string;
  policy_reason?: string;
  human_escalation: boolean;
  confidence: string;
  evidence_cited: string[];
  execution_result?: string;
  failure_state?: string;
  guard_rejection_reason?: string;
  idempotency_key?: string;
  prev_hash: string;
  hash: string;
}

// ---------------------------------------------------------------------------
// Evaluation (§7.6)
// ---------------------------------------------------------------------------
export interface ConfusionMatrix {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface ReliabilityBin {
  bucket: string;
  predicted_mean: number;
  observed_rate: number;
  count: number;
}

export interface EvaluationMetrics {
  module: 'fraud_spike';
  detector_version: string;
  decision_threshold: number;
  dataset: string;
  dataset_sha256: string;
  generated_at: string;
  windows: number;
  positives: number;
  prevalence: number;
  precision: number;
  recall: number;
  f1: number;
  fpr: number;
  fnr: number;
  accuracy: number;
  pr_auc: number;
  brier_score: number;
  false_positive_cost_inr: number; // sum of legitimate transaction value wrongly flagged
  false_positive_windows: number;
  value_protected_inr: number; // fraudulent transaction value in true-positive windows (held-out estimate)
  confusion_matrix: ConfusionMatrix;
  reliability_curve: ReliabilityBin[];
  calibration: {
    method: string;
    intercept: number;
    slope: number;
    fit_dev_brier: number;
  };
  notes?: string;
}

export interface EvaluationNotFound {
  status: 'not_evaluated';
  message: string;
  hint: string;
}

// ---------------------------------------------------------------------------
// API payloads (snake_case on the wire)
// ---------------------------------------------------------------------------
export interface PipelineStageTrace {
  stage: string;
  status: 'ok' | 'failed' | 'skipped';
  detail?: unknown;
  duration_ms?: number;
}

export interface PipelineResponse {
  type: string;
  merchant_id: string;
  event_id: string;
  stages: PipelineStageTrace[];
  detector?: AnyDetectorResult;
  agent?: AgentOutput;
  guard?: { accepted: boolean; reason?: string };
  policy?: PolicyResult;
  execution?: { status: string; action?: string; detail?: string; idempotent_replay?: boolean };
  escalation?: { required: boolean; reason?: string; queue_id?: string };
  audit_id?: string;
  audit_hash?: string;
}

export interface DashboardStats {
  totals: {
    transactions: number;
    amount_at_risk_inr: number;
    active_investigations: number;
    escalations: number;
    decisions: number;
  };
  by_module: Record<string, { decisions: number; escalated: number; approved: number; failed: number }>;
  recent_decisions: AuditRecord[];
  top_flagged_windows: Array<{
    window: string;
    merchant_id: string;
    amount_flagged_inr: number;
    probability: number;
  }>;
}
