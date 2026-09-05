/**
 * Middleware (§21): demo-grade API-key check (explicitly labeled demo auth,
 * not production auth — stubbed JWT slot ready to extend), centralized error
 * handler, raw-body capture for webhook signature verification.
 */

import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import logger from '../utils/logger';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.require_api_key) {
    return next();
  }
  const provided = req.headers['x-api-key'];
  if (typeof provided === 'string' && provided === config.demo_api_key) {
    return next();
  }
  res.status(401).json({ error: 'missing or invalid x-api-key header (demo auth — see README §21)' });
}

/**
 * Raw-body capture for the webhook route: signature MUST be computed over the
 * exact bytes Razorpay sent, not a re-serialization (§19).
 *
 * NOTE: express.json runs at the app level where req.path is the FULL path
 * (/api/webhooks/razorpay) — match by suffix so the capture actually fires
 * for the mounted route. (The original equality check never matched and
 * every signed webhook was rejected with "raw body not captured" — found by
 * the checkout integration tests, fixed here once.)
 */
export function rawBodyForWebhook(req: Request, _res: Response, buf: Buffer, encoding: string): void {
  // body-parser passes encoding as 'utf-8' (with hyphen) for JSON bodies —
  // accept both spellings; the bytes are identical either way.
  const isUtf8 = encoding === 'utf8' || encoding === 'utf-8';
  if (req.path.endsWith('/webhooks/razorpay') && isUtf8) {
    (req as Request & { rawBody?: Buffer }).rawBody = buf;
  }
}

/** Centralized error handler — never leak stack traces to the client. */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err: err.message, stack: err.stack }, 'unhandled route error');
  res.status(500).json({ error: 'internal server error' });
}

/** 404 for unknown API routes. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: `unknown route: ${req.method} ${req.path}` });
}

/** Stub JWT slot (§21): replace body with real verification when extending. */
export function jwtAuthStub(_req: Request, _res: Response, next: NextFunction): void {
  // Intentional no-op placeholder for production auth extension.
  next();
}
