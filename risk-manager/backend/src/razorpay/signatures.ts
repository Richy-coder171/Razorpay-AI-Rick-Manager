/**
 * Razorpay signature mechanics (§19) — verified against current docs.
 *
 * CRITICAL: webhook signatures and checkout payment signatures are DIFFERENT
 * HMACs with DIFFERENT secrets over DIFFERENT inputs:
 *  - Webhook:    HMAC-SHA256 over the RAW request body, keyed with the
 *                WEBHOOK secret (configured in the Dashboard, NOT the API
 *                key secret). Must run on raw bytes — re-serializing req.body
 *                with JSON.stringify() before hashing is the single most
 *                common way this check silently fails.
 *  - Checkout:   HMAC-SHA256 over `order_id|payment_id`, keyed with the
 *                API KEY SECRET (not the webhook secret).
 */

import crypto from 'crypto';

/** Webhook signature: HMAC-SHA256 over the RAW request body + webhook secret. */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signature: string,
  webhookSecret: string
): boolean {
  if (!webhookSecret || !signature) return false;
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return timingSafeEqualHex(expected, signature);
}

/** Checkout payment signature: HMAC-SHA256 over `order_id|payment_id` + key secret. */
export function verifyPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string
): boolean {
  if (!keySecret || !signature || !orderId || !paymentId) return false;
  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return timingSafeEqualHex(expected, signature);
}

function timingSafeEqualHex(expectedHex: string, receivedHex: string): boolean {
  const a = Buffer.from(expectedHex, 'utf8');
  const b = Buffer.from(receivedHex, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}
