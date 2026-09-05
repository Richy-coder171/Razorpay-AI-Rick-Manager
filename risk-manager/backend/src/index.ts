/**
 * Risk Manager Backend — entry point (§20, §21).
 *
 * Security stack: helmet, cors allowlist, express-rate-limit (tighter on
 * /api/agent|demo), demo-grade x-api-key auth (labeled demo auth in README),
 * pino structured logging with PII redaction, centralized error handling.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

dotenv.config();

import { config } from './config';
import logger from './utils/logger';
import { apiKeyAuth, rawBodyForWebhook, errorHandler, notFoundHandler } from './middleware';
import { fraudSpikeRoutes } from './routes/fraudSpike';
import { returnRiskRoutes } from './routes/returnRisk';
import { abuseRingRoutes } from './routes/abuseRing';
import { chargebackRoutes } from './routes/chargeback';
import { auditRoutes } from './routes/audit';
import { evaluationRoutes } from './routes/evaluation';
import { demoRoutes } from './routes/demo';
import { dashboardRoutes } from './routes/dashboard';
import { policyRoutes } from './routes/policy';
import { webhookRoutes } from './routes/webhooks';
import { razorpayRoutes } from './routes/razorpay';
import { riskPipeline } from './services/container';
import { CALIBRATION_SOURCE } from './detectors/fraudSpike';

const app = express();
const PORT = config.port;

// --- Security middleware ---
app.use(helmet());
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || config.cors_origins.includes(origin)) return cb(null, true);
      cb(new Error(`origin not allowed: ${origin}`));
    },
  })
);
app.use(express.json({ limit: '10mb', verify: rawBodyForWebhook }));

// --- Rate limiting ---
const generalLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
const sensitiveLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
app.use('/api', generalLimiter);
app.use('/api/demo', sensitiveLimiter);
app.use('/api/webhooks', sensitiveLimiter);

// --- Demo API-key auth (skip for health/dashboard/policy/evaluation so the UI renders cold) ---
app.use('/api', (req, res, next) => {
  if (
    req.path === '/health' ||
    req.path.startsWith('/dashboard') ||
    req.path.startsWith('/policy') ||
    req.path.startsWith('/evaluation') ||
    // Webhooks authenticate via their OWN HMAC signature (x-razorpay-signature
    // over the raw body, verified in webhookHandler) — Razorpay's servers
    // cannot send a demo API key, so API-key auth here would reject every
    // real webhook. The signature IS the auth for this route.
    req.path.startsWith('/webhooks/razorpay')
  ) {
    return next();
  }
  return apiKeyAuth(req, res, next);
});

// --- Routes ---
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    db_driver: config.db_driver,
    llm_provider: config.openrouter_api_key ? config.llm_provider : 'mock',
    payment_provider: config.payment_provider,
    fraud_spike_calibration: CALIBRATION_SOURCE,
  });
});

app.get('/api/risk/alerts', async (_req, res) => {
  const escalated = await import('./services/container').then((m) => m.auditService.getRecords({ escalated: true, limit: 50 }));
  res.json({ alerts: escalated, total: escalated.length });
});

app.post('/api/agent/decision', async (req, res) => {
  // Accepts any module event and runs the full pipeline through the agent.
  const { module, ...rest } = req.body || {};
  if (!module || !['fraud_spike', 'return_risk', 'abuse_ring', 'chargeback'].includes(module)) {
    return res.status(400).json({ error: 'body.module must be one of fraud_spike|return_risk|abuse_ring|chargeback' });
  }
  // Route to the appropriate pipeline event shape via demo-style passthrough:
  // the caller supplies the same payload as the module's POST /api/risk/* route.
  try {
    const { buildAgentDecisionEvent } = await import('./services/agentDecisionBridge');
    const event = buildAgentDecisionEvent(module, rest);
    const response = await riskPipeline.process(event, rest.event_id);
    return res.json(response);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'agent decision failed');
    return res.status(400).json({ error: (err as Error).message });
  }
});

app.use('/api/dashboard', dashboardRoutes);   // GET /api/dashboard
app.use('/api/policy', policyRoutes);         // GET /api/policy/config
app.use('/api/risk/fraud-spike', fraudSpikeRoutes);
app.use('/api/risk/return-risk', returnRiskRoutes);
app.use('/api/risk/abuse-ring', abuseRingRoutes);
app.use('/api/risk/chargeback', chargebackRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/evaluation', evaluationRoutes);
app.use('/api/demo', demoRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/razorpay', razorpayRoutes);   // POST /api/razorpay/order, GET /api/razorpay/payments

// --- Errors ---
app.use(notFoundHandler);
app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info({ port: PORT, db: config.db_driver, llm: config.llm_provider, payments: config.payment_provider }, 'Risk Manager backend running');
  });
}

export default app;
