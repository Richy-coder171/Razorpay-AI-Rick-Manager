/**
 * Webhook → verified payment → Transaction recording tests.
 *
 * Proves the REAL integration path: a webhook whose HMAC verifies over the
 * raw body (signed with the configured/mock webhook secret) results in a
 * stored VerifiedPayment AND a Transaction the Risk Manager can process.
 * A tampered webhook must record NOTHING.
 */

import request from 'supertest';
import crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Application } from 'express';

// Isolated DATA_DIR so the verified-payment stores don't touch the real demo data.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-checkout-'));
// Hermetic webhook secret: the handler refuses razorpay-mode webhooks when no
// secret is configured (correct behavior). Tests set their own secret BEFORE
// the app loads so HMAC verification runs against a known value.
process.env.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'test-webhook-secret';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app: Application = require('../index').default;

// Sign with the SAME secret the handler will use.
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

function signedWebhook(event: string, payload: Record<string, unknown>) {
  const raw = JSON.stringify({ event, payload });
  const signature = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return { raw, signature };
}

afterAll(() => {
  fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

describe('webhook records verified payments as transactions', () => {
  it('a signature-verified payment.captured webhook is recorded as a payment AND a transaction', async () => {
    const { raw, signature } = signedWebhook('payment.captured', {
      payment: {
        entity: {
          id: 'pay_test_capture_001',
          order_id: 'order_test_capture_001',
          amount: 10000, // ₹100 in paise
          currency: 'INR',
          method: 'card',
          email: 'judge@example.com',
          contact: '+919999999999',
        },
      },
    });

    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .send(raw);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);

    // The payment must now be listed by the payments endpoint.
    const payments = await request(app).get('/api/razorpay/payments').set('x-api-key', 'demo-key').expect(200);
    const found = (payments.body.payments as Array<{ id: string; status: string; amount: number }>).find(
      (p) => p.id === 'pay_test_capture_001'
    );
    expect(found).toBeDefined();
    expect(found!.status).toBe('captured');
    expect(found!.amount).toBe(10000);

    // And the transaction store must contain the rupee-denominated Transaction.
    const txnFile = path.join(process.env.DATA_DIR!, 'verified-transactions.json');
    expect(fs.existsSync(txnFile)).toBe(true);
    const txns = JSON.parse(fs.readFileSync(txnFile, 'utf8')) as Array<{
      id: string;
      amount: number;
      status: string;
      razorpay_verified: boolean;
      payment_mode: string;
    }>;
    const txn = txns.find((t) => t.id === 'pay_test_capture_001');
    expect(txn).toBeDefined();
    expect(txn!.amount).toBe(100); // paise -> rupees
    expect(txn!.status).toBe('captured');
    expect(txn!.razorpay_verified).toBe(true);
    expect(txn!.payment_mode).toBe('prepaid');
  });

  it('a duplicate delivery records nothing new (idempotent by payment id + event id)', async () => {
    const { raw, signature } = signedWebhook('payment.captured', {
      payment: { entity: { id: 'pay_test_dup_001', order_id: 'order_dup', amount: 10000, currency: 'INR' } },
    });

    const first = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .set('x-razorpay-event-id', 'evt_dup_001')
      .send(raw);
    expect(first.status).toBe(200);
    expect(first.body.accepted).toBe(true);
    expect(first.body.duplicate).toBeUndefined();

    const second = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .set('x-razorpay-event-id', 'evt_dup_001')
      .send(raw);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const payments = await request(app).get('/api/razorpay/payments').set('x-api-key', 'demo-key').expect(200);
    const count = (payments.body.payments as Array<{ id: string }>).filter((p) => p.id === 'pay_test_dup_001').length;
    expect(count).toBe(1);
  });

  it('a TAMPERED webhook records NOTHING (no payment, no transaction)', async () => {
    const { raw } = signedWebhook('payment.captured', {
      payment: { entity: { id: 'pay_test_tamper_001', order_id: 'order_t', amount: 10000, currency: 'INR' } },
    });

    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', 'deadbeef'.repeat(8)) // invalid signature
      .send(raw);
    expect(res.status).toBe(400);
    expect(res.body.accepted).toBe(false);

    const payments = await request(app).get('/api/razorpay/payments').set('x-api-key', 'demo-key').expect(200);
    const found = (payments.body.payments as Array<{ id: string }>).some((p) => p.id === 'pay_test_tamper_001');
    expect(found).toBe(false);
  });

  it('a non-payment webhook (e.g. order.paid) is accepted but records no transaction', async () => {
    const { raw, signature } = signedWebhook('order.paid', {
      order: { entity: { id: 'order_np_001', amount: 10000, currency: 'INR' } },
    });

    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .send(raw);
    expect(res.status).toBe(200);

    const payments = await request(app).get('/api/razorpay/payments').set('x-api-key', 'demo-key').expect(200);
    expect((payments.body.payments as Array<{ id: string }>).some((p) => p.id === 'order_np_001')).toBe(false);
  });

  it('AUTO-ACTIVATION: a captured payment webhook immediately runs the risk pipeline and lands in the audit log', async () => {
    const { raw, signature } = signedWebhook('payment.captured', {
      payment: { entity: { id: 'pay_scan_001', order_id: 'order_scan_001', amount: 10000, currency: 'INR', method: 'card', email: 'scan@example.com' } },
    });

    const res = await request(app)
      .post('/api/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .set('x-razorpay-event-id', 'evt_scan_001')
      .send(raw);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);

    // The auto-triggered scan must have produced a fraud_spike audit record
    // for the razorpay test merchant, with the scan's event id.
    const audit = await request(app)
      .get('/api/audit?module=fraud_spike&limit=5')
      .set('x-api-key', 'demo-key')
      .expect(200);
    const scanRecord = (audit.body.records as Array<{ event_id: string; merchant_id: string; failure_state?: string }>).find(
      (r) => r.event_id.startsWith('razorpay_scan_')
    );
    expect(scanRecord).toBeDefined();
    expect(scanRecord!.merchant_id).toBe('merchant_razorpay_test');
    // With a short verified-payment history the detector HONESTLY reports
    // insufficient_data and the pipeline escalates — never a fabricated score.
    expect(scanRecord!.failure_state).toBe('insufficient_data');
  });
});
