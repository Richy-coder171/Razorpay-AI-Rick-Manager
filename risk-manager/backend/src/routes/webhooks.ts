import { Router, Request, Response } from 'express';
import { webhookHandler, paymentProvider, providerModeBanner, riskPipeline } from '../services/container';
import { verifyPaymentSignature } from '../razorpay/signatures';
import { extractPaymentFromWebhook, recordVerifiedPayment, runRiskScanOnVerifiedPayments } from '../razorpay/checkout';
import logger from '../utils/logger';
import { z } from 'zod';

const router = Router();

/**
 * Razorpay webhook endpoint (§19). Signature over RAW body + x-razorpay-event-id
 * idempotency. In mock provider mode (default), the webhook secret is a
 * documented demo secret; the verification mechanics are identical.
 */
router.post('/razorpay', async (req: Request, res: Response) => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    return res.status(400).json({ error: 'raw body not captured — cannot verify signature' });
  }

  const result = await webhookHandler.handle(
    rawBody,
    req.headers['x-razorpay-signature'] as string | undefined,
    req.headers['x-razorpay-event-id'] as string | undefined,
    req.body as { event: string; payload?: Record<string, unknown> }
  );

  if (!result.accepted) {
    return res.status(400).json(result);
  }

  // REAL INTEGRATION POINT: a signature-verified payment webhook is recorded
  // as a Transaction the Risk Manager can process. Non-payment events and
  // duplicate deliveries are skipped (duplicates returned above).
  if (!result.duplicate) {
    const payment = extractPaymentFromWebhook((req.body?.payload ?? {}) as Record<string, unknown>);
    if (payment) {
      try {
        const record = await recordVerifiedPayment(req.body.event, payment);

        // AUTO-TRIGGERED RISK SCAN: a captured payment immediately activates
        // the Risk Manager — the real fraud-spike pipeline runs over the
        // merchant's real verified-transaction window and lands in the audit
        // log. Failures are logged but never fail the webhook response.
        if (req.body.event === 'payment.captured' && record.status === 'captured') {
          try {
            const scan = await runRiskScanOnVerifiedPayments('merchant_razorpay_test', riskPipeline);
            logger.info({ ran: scan.ran, reason: scan.reason, event_id: scan.event_id }, 'post-payment risk scan');
          } catch (err) {
            logger.error({ err: (err as Error).message }, 'post-payment risk scan failed');
          }
        }
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'failed to record verified payment');
        // Do not fail the webhook response: the idempotency key already
        // marked this event processed, and failing would trigger a redelivery
        // that dedupes to this same outcome. Logged + auditable path.
      }
    }
  }

  res.json(result);
});

/** Checkout payment signature verification (§19) — order_id|payment_id HMAC. */
const verifySchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

router.post('/razorpay/verify-payment', async (req: Request, res: Response) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  }

  const ok = await paymentProvider.verifyPaymentSignature(
    parsed.data.razorpay_order_id,
    parsed.data.razorpay_payment_id,
    parsed.data.razorpay_signature
  );
  res.json({ verified: ok, provider: paymentProvider.info.name, mode: paymentProvider.info.mode });
});

router.get('/provider-mode', (_req: Request, res: Response) => {
  res.json(providerModeBanner());
});

export { router as webhookRoutes };
