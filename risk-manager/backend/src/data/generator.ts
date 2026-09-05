/**
 * Seeded synthetic data generator v2 (§18).
 *
 * DETERMINISM: all randomness flows through a mulberry32 PRNG seeded from
 * `--seed 42`. Two runs with the same seed produce byte-identical data.
 *
 * DEFENSE-ONLY NOTICE: this generator produces *labeled abnormal patterns*
 * (volume spikes) for training/testing a detector. It contains no real payment
 * credentials, no evasion logic, and nothing offense-capable. See README §20.
 *
 * LABELING RULE (§18): exactly the windows in which a spike is injected are
 * labeled fraud_spike: true — no fuzzy decay-tail labeling.
 */

import {
  Transaction,
  Order,
  LinkedAccount,
  Dispute,
  SimilarOrder,
} from '../types';

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // Force uint32 so string/float seeds can't sneak in.
    this.state = seed >>> 0 || 1;
  }

  /** mulberry32 — small, fast, adequate for synthetic data. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  float(min = 0, max = 1): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    // inclusive on both ends
    return Math.floor(this.float(min, max + 1));
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  choice<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Box–Muller normal sample. */
  normal(mean: number, std: number): number {
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z * std;
  }

  /** Knuth algorithm for Poisson draws (fine for small lambdas). */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > L && k < 10000);
    return k - 1;
  }
}

// ---------------------------------------------------------------------------
// Static pools (synthetic identifiers only)
// ---------------------------------------------------------------------------
export const MERCHANT_IDS = ['merchant_001', 'merchant_002', 'merchant_003'] as const;

const REGIONS = ['north', 'south', 'east', 'west', 'central'] as const;
const CITIES = ['Mumbai', 'Delhi', 'Bengaluru', 'Chennai', 'Kolkata', 'Pune', 'Hyderabad'];

export interface MerchantProfile {
  merchant_id: string;
  baseline_txn_per_window: number; // Poisson lambda
  lognormal_mu: number;
  lognormal_sigma: number;
  baseline_failure_rate: number;
  repeat_customer_share: number; // share of txns from the usual customer pool
  usual_customer_pool: string[];
}

export function buildMerchantProfiles(rand: SeededRandom): MerchantProfile[] {
  return MERCHANT_IDS.map((merchant_id, mIdx) => {
    const poolSize = 40 + mIdx * 10;
    const usual_customer_pool = Array.from({ length: poolSize }, (_, i) => `cust_${merchant_id.slice(-3)}_${String(i).padStart(3, '0')}`);
    return {
      merchant_id,
      baseline_txn_per_window: [110, 70, 55][mIdx],
      lognormal_mu: Math.log([520, 340, 1250][mIdx]),
      lognormal_sigma: 0.5,
      baseline_failure_rate: 0.04 + mIdx * 0.01,
      repeat_customer_share: 0.85,
      usual_customer_pool,
    };
  });
}

// ---------------------------------------------------------------------------
// Window generation (10-minute windows per merchant)
// ---------------------------------------------------------------------------
export interface LabeledWindow {
  window_index: number;
  window_start: string;
  window_end: string;
  merchant_id: string;
  transactions: Transaction[];
  is_fraud_spike: boolean;
}

export interface GeneratedTimeline {
  windows: LabeledWindow[];
  merchant_profiles: MerchantProfile[];
}

export interface GenerateOptions {
  seed: number;
  windowCount: number;
  startDate?: Date;
  spikeRate?: number; // probability a window is a spike window
  includeMerchants?: readonly string[];
  /** Additional merchant profiles (e.g. the demo merchant) beyond the static pool. */
  extraProfiles?: readonly MerchantProfile[];
}

const WINDOW_MS = 10 * 60 * 1000;

function lognormalAmount(rand: SeededRandom, profile: MerchantProfile): number {
  // log-normal per merchant, floored at INR 10
  const z = Math.max(this_normalOnce(rand), -3);
  const amount = Math.exp(profile.lognormal_mu + profile.lognormal_sigma * z);
  return Math.max(10, Math.round(amount));
}

function this_normalOnce(rand: SeededRandom): number {
  const u1 = Math.max(rand.next(), 1e-12);
  const u2 = rand.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function pickCustomer(rand: SeededRandom, profile: MerchantProfile, spike: boolean, attackerPool: string[]): string {
  if (spike && rand.bool(0.7)) {
    // concentrated on fewer unique customers/cards
    return rand.choice(attackerPool);
  }
  if (rand.bool(profile.repeat_customer_share)) {
    return rand.choice(profile.usual_customer_pool);
  }
  return `cust_new_${rand.int(0, 99999)}`;
}

function pickRegion(rand: SeededRandom, spike: boolean, attackerRegion: string): string {
  if (spike && rand.bool(0.8)) return attackerRegion;
  return rand.choice(REGIONS);
}

export function generateTimeline(opts: GenerateOptions): GeneratedTimeline {
  const rand = new SeededRandom(opts.seed);
  const allProfiles = [...buildMerchantProfiles(rand), ...(opts.extraProfiles ?? [])];
  const profiles = allProfiles.filter(
    (p) => !opts.includeMerchants || opts.includeMerchants.includes(p.merchant_id)
  );
  if (profiles.length === 0) {
    throw new Error(`generateTimeline: no merchant profiles matched (includeMerchants=${opts.includeMerchants?.join(', ')})`);
  }
  const startDate = opts.startDate || new Date('2026-01-01T00:00:00.000Z');
  const spikeRate = opts.spikeRate ?? 0.1;

  const windows: LabeledWindow[] = [];
  let wIdx = 0;

  for (let i = 0; i < opts.windowCount; i++) {
    const profile = profiles[i % profiles.length];
    const windowStart = new Date(startDate.getTime() + wIdx * WINDOW_MS);
    const windowEnd = new Date(windowStart.getTime() + WINDOW_MS);

    // Merchant-specific diurnal pattern: busier during business hours.
    const hour = windowStart.getUTCHours();
    const diurnal = 0.6 + 0.8 * Math.sin(((hour - 4) / 24) * 2 * Math.PI);
    const lambda = Math.max(5, profile.baseline_txn_per_window * Math.max(diurnal, 0.3));

    const isSpike = rand.bool(spikeRate);

    // attacker pool per spike (small set of synthetic ids)
    const attackerPool = Array.from({ length: 3 }, () => `cust_attack_${rand.int(0, 99999)}`);
    const attackerRegion = rand.choice(REGIONS);

    let count: number;
    if (isSpike) {
      // randomized multiplier 3–7x baseline for a full window (label exactly this window)
      const multiplier = rand.float(3, 7);
      count = Math.max(2, Math.round(rand.poisson(lambda) * multiplier));
    } else {
      count = rand.poisson(lambda);
    }

    const transactions: Transaction[] = [];
    for (let t = 0; t < count; t++) {
      const at = new Date(windowStart.getTime() + rand.next() * WINDOW_MS);
      const customer = pickCustomer(rand, profile, isSpike, attackerPool);
      const region = pickRegion(rand, isSpike, attackerRegion);
      const failed = rand.bool(isSpike ? 0.12 : profile.baseline_failure_rate);
      transactions.push({
        id: `pay_${wIdx.toString().padStart(6, '0')}_${t.toString().padStart(4, '0')}`,
        merchant_id: profile.merchant_id,
        amount: lognormalAmount(rand, profile),
        currency: 'INR',
        status: failed ? 'failed' : 'captured',
        payment_mode: rand.bool(0.65) ? 'prepaid' : 'cod',
        customer_id: customer,
        card_hash: rand.bool(0.85) ? `card_${rand.int(0, 9999).toString().padStart(4, '0')}` : undefined,
        device_fingerprint: rand.bool(0.8) ? `device_${rand.int(0, 499)}` : undefined,
        ip_hash: `ip_${rand.int(0, 1999)}`,
        region,
        created_at: at.toISOString(),
      });
    }

    windows.push({
      window_index: wIdx,
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      merchant_id: profile.merchant_id,
      transactions,
      is_fraud_spike: isSpike,
    });
    wIdx++;
  }

  return { windows, merchant_profiles: profiles };
}

// ---------------------------------------------------------------------------
// Supporting-entity generators (return risk / abuse ring / chargeback demos)
// ---------------------------------------------------------------------------
export function generateOrder(rand: SeededRandom, merchantId: string): Order {
  const paymentMode = rand.bool(0.5) ? 'cod' : 'prepaid';
  const priorReturns = rand.int(0, 4);
  const failedDeliveries = rand.int(0, 3);
  const totalOrders = rand.int(1, 20);
  const similarCount = rand.int(0, 5);
  const similar: SimilarOrder[] = Array.from({ length: similarCount }, (_, i) => ({
    order_id: `ord_sim_${rand.int(0, 99999)}_${i}`,
    outcome: rand.bool(priorReturns / Math.max(totalOrders, 1)) ? 'returned' : rand.bool(0.9) ? 'delivered' : 'failed',
  }));

  return {
    order_id: `ord_${rand.int(0, 999999).toString().padStart(6, '0')}`,
    merchant_id: merchantId,
    customer_id: `cust_${rand.int(0, 99999)}`,
    order_value: Math.max(10, Math.round(rand.normal(1800, 900))),
    payment_mode: paymentMode,
    delivery_address: {
      serviceability: rand.choice(['high', 'medium', 'low'] as const),
      city: rand.choice(CITIES),
      state: 'TestState',
      pincode: String(rand.int(100000, 999999)),
    },
    customer_history: {
      prior_returns: priorReturns,
      failed_deliveries: failedDeliveries,
      total_orders: totalOrders,
      account_age_days: rand.int(5, 720),
      similar_past_orders: similar,
    },
    created_at: new Date().toISOString(),
    status: 'pending',
  };
}

export function generateLinkedAccountUniverse(rand: SeededRandom): LinkedAccount[] {
  // Build a small world of accounts where a few clusters genuinely share
  // attribute values (this is ground truth for the union-find clustering).
  const accounts: LinkedAccount[] = [];
  const clusterCount = 3;
  const signals = ['device', 'phone', 'email', 'address', 'payment', 'ip'] as const;

  for (let c = 0; c < clusterCount; c++) {
    const size = rand.int(3, 6);
    const shared: Partial<Record<(typeof signals)[number], string>> = {};
    for (const s of signals) {
      if (rand.bool(0.6)) {
        shared[s] = `${s}_${c}_${rand.int(0, 9999)}`;
      }
    }
    for (let i = 0; i < size; i++) {
      accounts.push({
        account_id: `acc_c${c}_${i.toString().padStart(2, '0')}`,
        shared_device_hash: shared.device,
        shared_phone_hash: shared.phone,
        shared_email_hash: shared.email,
        shared_address_hash: shared.address,
        shared_payment_identifier: shared.payment,
        shared_ip_hash: shared.ip,
        chargeback_count: rand.int(0, 5),
      });
    }
  }

  // Plus some isolated, unlinked accounts (should form singleton clusters).
  const isolated = rand.int(4, 8);
  for (let i = 0; i < isolated; i++) {
    accounts.push({
      account_id: `acc_iso_${i.toString().padStart(2, '0')}`,
      shared_device_hash: `device_iso_${i}`,
      chargeback_count: rand.int(0, 2),
    });
  }

  return accounts;
}

export function generateDispute(rand: SeededRandom, merchantId: string): Dispute {
  const reasonCodes = ['product_not_received', 'service_not_provided', 'fraudulent', 'duplicate', 'not_as_described'];
  const reasonCode = rand.choice(reasonCodes);
  const evidenceMap: Record<string, string[]> = {
    product_not_received: ['proof_of_delivery', 'customer_communication', 'tracking_info'],
    service_not_provided: ['proof_of_service', 'customer_communication', 'service_agreement'],
    fraudulent: ['avs_match', 'device_fingerprint', 'delivery_confirmation', 'customer_ip'],
    duplicate: ['transaction_receipt', 'customer_communication', 'refund_proof'],
    not_as_described: ['product_description', 'return_policy', 'customer_communication'],
  };
  const allEvidence = evidenceMap[reasonCode] || [];
  const available = allEvidence.filter(() => rand.bool(0.6));

  return {
    dispute_id: `disp_${rand.int(0, 999999).toString().padStart(6, '0')}`,
    merchant_id: merchantId,
    reason_code: reasonCode,
    amount: Math.max(10, Math.round(rand.normal(2500, 1200))),
    respond_by: new Date(Date.now() + rand.int(2, 12) * 24 * 60 * 60 * 1000).toISOString(),
    available_evidence: available,
  };
}
