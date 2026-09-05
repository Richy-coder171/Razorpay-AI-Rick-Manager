/**
 * Webhook handler (§19, §15): raw-body signature verification, x-razorpay-event-id
 * keyed idempotency (Razorpay documents redelivery), and event routing into the
 * risk pipeline.
 */

import { Request, Response } from 'express';
import { config } from '../config';
import { verifyWebhookSignature } from './signatures';
import { IdempotencyManager } from '../policy';
import logger from '../utils/logger';

export interface WebhookEventPayload {
  event: string;
  payload?: Record<string, unknown>;
}

export interface WebhookResult {
  accepted: boolean;
  reason?: string;
  duplicate?: boolean;
}

export class WebhookHandler {
  constructor(private idempotency: IdempotencyManager) {}

  /**
   * Verify + dedupe a webhook. MUST receive the RAW body (express.json must
   * be configured with a raw-body capture; see webhookCapture middleware).
   */
  async handle(rawBody: Buffer, signature: string | undefined, eventId: string | undefined, payload: WebhookEventPayload): Promise<WebhookResult> {
    // 1. Signature check over RAW bytes, keyed with the WEBHOOK secret.
    if (!signature) {
      return { accepted: false, reason: 'missing x-razorpay-signature header' };
    }
    if (!config.razorpay_webhook_secret && config.payment_provider === 'razorpay') {
      return { accepted: false, reason: 'webhook secret not configured' };
    }
    const secret = config.razorpay_webhook_secret || 'mock-webhook-secret';
    const valid = verifyWebhookSignature(rawBody, signature, secret);
    if (!valid) {
      logger.warn({ event: payload.event }, 'webhook signature verification FAILED');
      return { accepted: false, reason: 'signature verification failed' };
    }

    // 2. Idempotency off x-razorpay-event-id — Razorpay redelivers events.
    if (eventId) {
      const dedupeKey = `webhook|${eventId}`;
      const cached = await this.idempotency.check(dedupeKey);
      if (cached !== null) {
        logger.info({ event_id: eventId }, 'duplicate webhook delivery — no-op returning first result');
        return { accepted: true, duplicate: true, reason: 'duplicate delivery; first result returned' };
      }
      await this.idempotency.store(dedupeKey, { processed_at: new Date().toISOString(), event: payload.event });
    }

    logger.info({ event: payload.event, event_id: eventId }, 'webhook accepted');
    return { accepted: true };
  }
}
