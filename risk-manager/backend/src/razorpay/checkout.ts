/**
 * Razorpay Test Checkout service: creates REAL ₹100 orders via the Razorpay
 * Orders API (test mode) and records REAL webhook-verified payments as
 * Transactions for the Risk Manager.
 *
 * Secrets discipline:
 *  - RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are used ONLY here, server-side,
 *    for Basic-auth calls to api.razorpay.com. The key_id (public by design
 *    in Razorpay checkout) is returned to the frontend; the SECRET never
 *    leaves the backend.
 *  - Webhook verification reuses the existing webhookHandler HMAC machinery.
 *
 * Nothing is faked: orders come from Razorpay's API; payments are recorded
 * ONLY after a webhook's HMAC verifies over the raw body.
 */

import { createRepository } from '../models/repository';
import { Transaction } from '../types';
import { WindowFeatures, extractWindowFeatures } from '../features';
import logger from '../utils/logger';
import { config } from '../config';

/** A payment record created ONLY from a signature-verified webhook. */
export interface VerifiedPayment {
  id: string; // razorpay payment_id (pay_...)
  order_id: string;
  amount: number; // paise, from the webhook payload
  currency: string;
  status: 'captured' | 'failed';
  method?: string;
  email?: string;
  contact?: string;
  created_at: string; // ISO
  raw_event: string; // e.g. payment.captured
}

const paymentsRepo = createRepository<VerifiedPayment>('verified_payments', 'verified-payments.json');
const transactionsRepo = createRepository<Transaction & { razorpay_verified: boolean }>('verified_transactions', 'verified-transactions.json');

export interface CreateOrderResult {
  ok: boolean;
  error?: string;
  /** Public checkout fields — safe for the frontend (no secrets). */
  order?: { id: string; amount: number; currency: string; key_id: string; test_mode: boolean };
}

/** ₹100 = 10000 paise. */
export const TEST_AMOUNT_PAISE = 10_000;

/** Create a REAL ₹100 order via the Razorpay Orders API. */
export async function createTestOrder(): Promise<CreateOrderResult> {
  if (config.payment_provider !== 'razorpay') {
    return { ok: false, error: 'PAYMENT_PROVIDER is not razorpay' };
  }
  if (!config.razorpay_key_id || !config.razorpay_key_secret) {
    return { ok: false, error: 'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not configured' };
  }

  const auth = Buffer.from(`${config.razorpay_key_id}:${config.razorpay_key_secret}`).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: TEST_AMOUNT_PAISE,
        currency: 'INR',
        receipt: `riskmgr_test_${Date.now()}`,
        notes: { purpose: 'risk-manager-test-checkout', source: 'ai-risk-manager' },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.warn({ status: response.status, body: body.slice(0, 200) }, 'razorpay order creation failed');
      return { ok: false, error: `razorpay API ${response.status}: ${body.slice(0, 200)}` };
    }

    const order = (await response.json()) as { id: string; amount: number; currency: string };
    logger.info({ order_id: order.id, amount: order.amount }, 'razorpay test order created');

    return {
      ok: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        // key_id is PUBLIC in the Razorpay checkout model (it appears in every
        // checkout.js invocation on the web). The SECRET is never returned.
        key_id: config.razorpay_key_id,
        test_mode: config.razorpay_key_id.startsWith('rzp_test_'),
      },
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'razorpay order creation error');
    return { ok: false, error: `order creation failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Extract a payment from a payment.captured/payment.failed webhook payload. Never guesses. */
export function extractPaymentFromWebhook(
  payload: Record<string, unknown>
): { payment_id: string; order_id: string; amount: number; currency: string; method?: string; email?: string; contact?: string } | null {
  const entity = (payload as {
    payment?: { entity?: { id: string; order_id: string; amount: number; currency: string; method?: string; email?: string; contact?: string } };
  })?.payment?.entity;
  if (!entity || !entity.id || !entity.order_id) return null;
  return {
    payment_id: entity.id,
    order_id: entity.order_id,
    amount: entity.amount,
    currency: entity.currency,
    method: entity.method,
    email: entity.email,
    contact: entity.contact,
  };
}

/**
 * Record a SIGNATURE-VERIFIED payment and store it as a Transaction the Risk
 * Manager consumes. Called ONLY after webhookHandler.handle() accepted the HMAC.
 */
export async function recordVerifiedPayment(
  event: string,
  payment: NonNullable<ReturnType<typeof extractPaymentFromWebhook>>
): Promise<VerifiedPayment> {
  const record: VerifiedPayment = {
    id: payment.payment_id,
    order_id: payment.order_id,
    amount: payment.amount,
    currency: payment.currency,
    status: event === 'payment.captured' ? 'captured' : 'failed',
    method: payment.method,
    email: payment.email,
    contact: payment.contact,
    created_at: new Date().toISOString(),
    raw_event: event,
  };

  try {
    await paymentsRepo.insert(record);
  } catch (err) {
    if ((err as Error).message.includes('duplicate id')) {
      logger.info({ payment_id: record.id }, 'verified payment already recorded — skipping');
      return record;
    }
    throw err;
  }

  // Transaction shape (rupees, not paise) — exactly what the feature layer consumes.
  const transaction: Transaction & { razorpay_verified: boolean } = {
    id: payment.payment_id,
    merchant_id: 'merchant_razorpay_test',
    amount: payment.amount / 100,
    currency: payment.currency,
    status: record.status,
    payment_mode: 'prepaid',
    customer_id: payment.email || payment.contact || 'unknown_test_customer',
    created_at: record.created_at,
    razorpay_verified: true,
  };

  try {
    await transactionsRepo.insert(transaction);
    logger.info({ payment_id: transaction.id, amount_inr: transaction.amount }, 'razorpay-verified transaction stored for risk processing');
  } catch (err) {
    if (!(err as Error).message.includes('duplicate id')) throw err;
  }

  return record;
}

/** List verified payments (newest first) — for the demo UI. */
export async function listVerifiedPayments(limit = 20): Promise<VerifiedPayment[]> {
  const all = await paymentsRepo.findAll();
  return all.slice(0, limit);
}

/** All verified transactions for a merchant (chronological, oldest first) — real data source. */
export async function verifiedTransactionsFor(merchantId: string): Promise<Array<Transaction & { razorpay_verified: boolean }>> {
  const all = await transactionsRepo.findAll();
  return all.filter((t) => t.merchant_id === merchantId).reverse(); // findAll is newest-first
}

/**
 * AUTO-TRIGGERED RISK SCAN: after a verified payment webhook, run the REAL
 * fraud-spike pipeline over the REAL verified-transaction window for the
 * merchant — the same pipeline, detectors, policy, and audit as every other
 * event. Nothing is special-cased and nothing is fabricated: the current
 * window contains exactly the signature-verified Razorpay payments stored in
 * the last 10 minutes, and the trailing baseline is the same merchant's own
 * prior verified windows (current window excluded — a scan can never inflate
 * its own baseline).
 *
 * With few payments the detector honestly reports insufficient_data and the
 * pipeline escalates to a human — by design, never a guess.
 */
export async function runRiskScanOnVerifiedPayments(
  merchantId: string,
  pipeline: { process(event: unknown, eventId?: string): Promise<unknown> }
): Promise<{ ran: boolean; reason?: string; event_id?: string }> {
  const transactions = await verifiedTransactionsFor(merchantId);
  if (transactions.length === 0) {
    return { ran: false, reason: 'no verified transactions to scan' };
  }

  const WINDOW_MS = 10 * 60 * 1000;
  const now = Date.now();
  const currentStart = now - WINDOW_MS;

  // Current window: verified transactions from the last 10 minutes.
  const current = transactions.filter((t) => now - new Date(t.created_at).getTime() <= WINDOW_MS);
  if (current.length === 0) {
    return { ran: false, reason: 'no verified transactions in the last 10-minute window' };
  }

  // Trailing baseline: prior 10-minute windows of the SAME merchant's verified
  // history, ending where the current window begins, capped at 30 windows.
  const trailing: WindowFeatures[] = [];
  const oldest = new Date(transactions[0].created_at).getTime();
  for (let windowEnd = currentStart; windowEnd - WINDOW_MS >= oldest - WINDOW_MS && trailing.length < 30; windowEnd -= WINDOW_MS) {
    const inWindow = transactions.filter((t) => {
      const ts = new Date(t.created_at).getTime();
      return ts >= windowEnd - WINDOW_MS && ts < windowEnd;
    });
    if (inWindow.length === 0) continue; // no data for that window — skip, never fabricate counts
    trailing.push(
      extractWindowFeatures(inWindow, new Date(windowEnd - WINDOW_MS).toISOString(), new Date(windowEnd).toISOString())
    );
  }
  trailing.reverse(); // chronological, oldest trailing window first — what the detector expects

  const eventId = `razorpay_scan_${merchantId}_${Date.now()}`;
  await pipeline.process(
    {
      module: 'fraud_spike',
      merchant_id: merchantId,
      window: current,
      prior_window_features: trailing,
      window_start: new Date(currentStart).toISOString(),
      window_end: new Date(now).toISOString(),
    },
    eventId
  );

  logger.info(
    { merchant_id: merchantId, current_window_txns: current.length, trailing_windows: trailing.length, event_id: eventId },
    'auto-triggered risk scan on verified Razorpay payments'
  );
  return { ran: true, event_id: eventId };
}
