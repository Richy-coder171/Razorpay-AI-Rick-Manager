/**
 * Razorpay signature tests (§19, §23) — two DIFFERENT HMACs, different keys,
 * different inputs. Getting these right is a common integration bug.
 */

import { createHmac } from 'crypto';
import { verifyWebhookSignature, verifyPaymentSignature } from './signatures';

const WEBHOOK_SECRET = 'webhook_secret_xyz';
const KEY_SECRET = 'key_secret_abc';

describe('Razorpay signature verification', () => {
  describe('webhook signatures (raw body + webhook secret)', () => {
    it('accepts a correctly signed raw body', () => {
      const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { id: 'pay_123' } }));
      const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
      expect(verifyWebhookSignature(raw, signature, WEBHOOK_SECRET)).toBe(true);
    });

    it('REJECTS a signature computed over re-serialized JSON (the classic bug)', () => {
      // Original raw bytes contain spaces; JSON.stringify(JSON.parse(...))
      // produces compact bytes -> different HMAC input -> verification fails.
      const raw = Buffer.from('{"event": "payment.captured", "payload": {"id": "pay_123"}}');
      const reSerialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString())));
      expect(reSerialized.equals(raw)).toBe(false); // sanity: bytes differ
      const signature = createHmac('sha256', WEBHOOK_SECRET).update(reSerialized).digest('hex');
      expect(verifyWebhookSignature(raw, signature, WEBHOOK_SECRET)).toBe(false);
    });

    it('REJECTS a signature keyed with the API key secret (wrong key)', () => {
      const raw = Buffer.from('{"event":"x"}');
      const signature = createHmac('sha256', KEY_SECRET).update(raw).digest('hex');
      expect(verifyWebhookSignature(raw, signature, WEBHOOK_SECRET)).toBe(false);
    });

    it('REJECTS a tampered body under a valid signature', () => {
      const raw = Buffer.from('{"event":"payment.captured"}');
      const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
      const tampered = Buffer.from('{"event":"payment.failed","amount":99999}');
      expect(verifyWebhookSignature(tampered, signature, WEBHOOK_SECRET)).toBe(false);
    });

    it('rejects empty signatures or secrets', () => {
      const raw = Buffer.from('{}');
      expect(verifyWebhookSignature(raw, '', WEBHOOK_SECRET)).toBe(false);
      expect(verifyWebhookSignature(raw, 'abc', '')).toBe(false);
    });
  });

  describe('checkout payment signatures (order_id|payment_id + key secret)', () => {
    it('accepts a correctly signed order|payment pair', () => {
      const orderId = 'order_123';
      const paymentId = 'pay_456';
      const signature = createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
      expect(verifyPaymentSignature(orderId, paymentId, signature, KEY_SECRET)).toBe(true);
    });

    it('REJECTS swapped order/payment ids', () => {
      const orderId = 'order_123';
      const paymentId = 'pay_456';
      const signature = createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
      expect(verifyPaymentSignature(paymentId, orderId, signature, KEY_SECRET)).toBe(false);
    });

    it('REJECTS a signature keyed with the webhook secret (wrong key)', () => {
      const signature = createHmac('sha256', WEBHOOK_SECRET).update('order_123|pay_456').digest('hex');
      expect(verifyPaymentSignature('order_123', 'pay_456', signature, KEY_SECRET)).toBe(false);
    });
  });
});
