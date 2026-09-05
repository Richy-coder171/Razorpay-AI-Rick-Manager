/**
 * Demo event factory (§18 + §24): builds realistic synthetic events for the
 * demo buttons. Each renders the FULL pipeline live using the real code paths.
 */

import { SeededRandom, generateTimeline, generateOrder, generateLinkedAccountUniverse, generateDispute, MerchantProfile } from '../data/generator';
import { RiskEvent } from './riskPipeline';
import { WindowFeatures } from '../features';
import { extractWindowFeatures } from '../features';
import { Transaction } from '../types';

export type DemoScenario =
  | 'normal_traffic'
  | 'fraud_spike'
  | 'return_risk'
  | 'abuse_ring'
  | 'chargeback'
  | 'detector_failure'
  | 'invalid_data'
  | 'payment_timeout';

/** The demo merchant's traffic profile (Poisson lambda ~100/window like merchant_001). */
const DEMO_MERCHANT_PROFILE: MerchantProfile = {
  merchant_id: 'merchant_demo',
  baseline_txn_per_window: 100,
  lognormal_mu: Math.log(500),
  lognormal_sigma: 0.5,
  baseline_failure_rate: 0.05,
  repeat_customer_share: 0.85,
  usual_customer_pool: Array.from({ length: 40 }, (_, i) => `cust_demo_${String(i).padStart(3, '0')}`),
};

/** Rolling per-merchant feature history shared across demo runs (in-memory). */
const featureHistory: Map<string, WindowFeatures[]> = new Map();

/** Warm up trailing history so the detector has >= MIN_SAMPLES windows. */
function warmHistory(merchantId: string, rand: SeededRandom, count = 35): WindowFeatures[] {
  let hist = featureHistory.get(merchantId);
  if (!hist || hist.length < count) {
    hist = [];
    const timeline = generateTimeline({
      seed: rand.int(1, 2_000_000_000),
      windowCount: count * 3,
      includeMerchants: [merchantId],
      extraProfiles: [DEMO_MERCHANT_PROFILE],
    });
    const mine = timeline.windows.filter((w) => w.merchant_id === merchantId);
    for (const w of mine.slice(0, count)) {
      hist.push(extractWindowFeatures(w.transactions, w.window_start, w.window_end));
    }
    featureHistory.set(merchantId, hist);
  }
  return hist;
}

function pushHistory(merchantId: string, features: WindowFeatures): void {
  const hist = featureHistory.get(merchantId) || [];
  hist.push(features);
  if (hist.length > 60) hist.shift();
  featureHistory.set(merchantId, hist);
}

export interface DemoContext {
  scenario: DemoScenario;
  event: RiskEvent;
  meta?: Record<string, unknown>;
}

export function buildDemoEvent(scenario: DemoScenario, seed = Date.now() % 2_000_000_000): DemoContext {
  const rand = new SeededRandom(seed);
  const merchantId = 'merchant_demo';

  switch (scenario) {
    case 'normal_traffic':
    case 'fraud_spike': {
      // Build a fresh window: normal ~ Poisson(baseline), spike ~ 4-6x.
      const isSpike = scenario === 'fraud_spike';
      warmHistory(merchantId, rand);
      const lambda = 100;
      const count = isSpike ? Math.round(lambda * (4 + rand.float(0, 2))) : Math.max(5, rand.poisson(lambda));
      const windowStart = new Date();
      const window: Transaction[] = [];
      const attackerPool = ['cust_attack_1', 'cust_attack_2', 'cust_attack_3'];
      for (let i = 0; i < count; i++) {
        const concentrated = isSpike && rand.bool(0.7);
        window.push({
          id: `pay_demo_${seed}_${i.toString().padStart(4, '0')}`,
          merchant_id: merchantId,
          amount: Math.max(10, Math.round(expRand(rand, isSpike && concentrated ? 1500 : 500, 0.5))),
          currency: 'INR',
          status: rand.bool(isSpike ? 0.12 : 0.05) ? 'failed' : 'captured',
          payment_mode: rand.bool(0.65) ? 'prepaid' : 'cod',
          customer_id: concentrated ? rand.choice(attackerPool) : `cust_demo_${rand.int(0, 40)}`,
          card_hash: rand.bool(0.85) ? `card_${rand.int(0, 999)}` : undefined,
          device_fingerprint: rand.bool(0.8) ? `device_${rand.int(0, 99)}` : undefined,
          ip_hash: `ip_${rand.int(0, 499)}`,
          region: concentrated ? 'north' : rand.choice(['north', 'south', 'east', 'west', 'central'] as const),
          created_at: new Date(windowStart.getTime() + rand.next() * 600_000).toISOString(),
        });
      }
      const features = extractWindowFeatures(window);
      pushHistory(merchantId, features);
      return {
        scenario,
        event: {
          module: 'fraud_spike',
          merchant_id: merchantId,
          window,
          prior_window_features: featureHistory.get(merchantId)!.slice(0, -1), // trailing only — exclude current
          window_start: windowStart.toISOString(),
          window_end: new Date(windowStart.getTime() + 600_000).toISOString(),
        },
        meta: { transactions: count, labeled: isSpike ? 'injected spike' : 'normal traffic' },
      };
    }

    case 'return_risk': {
      const order = generateOrder(rand, merchantId);
      return { scenario, event: { module: 'return_risk', merchant_id: merchantId, order }, meta: { order_id: order.order_id } };
    }

    case 'abuse_ring': {
      const accounts = generateLinkedAccountUniverse(rand);
      const anchor = accounts.find((a) => a.account_id.startsWith('acc_c'))!; // anchor into a real cluster
      return {
        scenario,
        event: { module: 'abuse_ring', merchant_id: merchantId, accounts, anchor_account_id: anchor.account_id },
        meta: { accounts: accounts.length },
      };
    }

    case 'chargeback': {
      const dispute = generateDispute(rand, merchantId);
      return { scenario, event: { module: 'chargeback', merchant_id: merchantId, dispute }, meta: { dispute_id: dispute.dispute_id } };
    }

    case 'detector_failure': {
      // Real fault path: generator builds a window; pipeline's detector call
      // hangs because faultInjection.detector_timeout is set by the route.
      const window: Transaction[] = [];
      return {
        scenario,
        event: {
          module: 'fraud_spike',
          merchant_id: merchantId,
          window,
          prior_window_features: [],
          window_start: new Date().toISOString(),
        },
        meta: { injected_fault: 'detector_timeout' },
      };
    }

    case 'invalid_data': {
      // INVALID DATA: an event with an empty window and no trailing history.
      // No fault is injected — the REAL detector runs, reports
      // failure_state=insufficient_data (it refuses to guess), and the
      // pipeline deterministically escalates to a human. This exercises the
      // genuine "garbage in -> no risk score -> no automatic action" path,
      // distinct from detector_failure (which injects a timeout).
      return {
        scenario,
        event: {
          module: 'fraud_spike',
          merchant_id: merchantId,
          window: [],
          prior_window_features: [],
          window_start: new Date().toISOString(),
        },
        meta: { invalid_event: 'empty window, no trailing history' },
      };
    }

    case 'payment_timeout': {
      // A high-confidence fraud spike that WILL pass policy, then the action
      // executor hangs (faultInjection.action_executor_timeout set by route)
      // demonstrating check-downstream -> retry-once -> escalate.
      warmHistory(merchantId, rand);
      const windowStart = new Date();
      const window: Transaction[] = [];
      const count = Math.round(100 * 6);
      for (let i = 0; i < count; i++) {
        window.push({
          id: `pay_timeout_${seed}_${i.toString().padStart(4, '0')}`,
          merchant_id: merchantId,
          amount: Math.max(10, Math.round(expRand(rand, 1600, 0.4))),
          currency: 'INR',
          status: rand.bool(0.85) ? 'captured' : 'failed',
          payment_mode: 'prepaid',
          customer_id: `cust_attack_${rand.int(0, 3)}`,
          card_hash: `card_attack_${rand.int(0, 2)}`,
          device_fingerprint: `device_attack_${rand.int(0, 2)}`,
          ip_hash: `ip_attack_${rand.int(0, 2)}`,
          region: 'north',
          created_at: new Date(windowStart.getTime() + rand.next() * 600_000).toISOString(),
        });
      }
      const features = extractWindowFeatures(window);
      pushHistory(merchantId, features);
      return {
        scenario,
        event: {
          module: 'fraud_spike',
          merchant_id: merchantId,
          window,
          prior_window_features: featureHistory.get(merchantId)!.slice(0, -1),
          window_start: windowStart.toISOString(),
          window_end: new Date(windowStart.getTime() + 600_000).toISOString(),
        },
        meta: { injected_fault: 'action_executor_timeout' },
      };
    }
  }
}

function expRand(rand: SeededRandom, median: number, sigma: number): number {
  return median * Math.exp(sigma * (rand.next() * 2 - 1));
}
