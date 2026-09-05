import { Router, Request, Response } from 'express';
import { riskPipeline, auditService, idempotencyManager } from '../services/container';
import { buildDemoEvent, DemoScenario } from '../services/demoFactory';
import { setFault, faultInjection } from '../execution';
import { computeIdempotencyKey } from '../policy';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

const SCENARIOS: DemoScenario[] = [
  'normal_traffic',
  'fraud_spike',
  'return_risk',
  'abuse_ring',
  'chargeback',
  'detector_failure',
  'invalid_data',
  'payment_timeout',
];

router.post('/simulate/:scenario', async (req: Request, res: Response) => {
  const scenario = req.params.scenario as DemoScenario;
  if (!SCENARIOS.includes(scenario)) {
    return res.status(400).json({ error: `unknown scenario: ${scenario}`, available: SCENARIOS });
  }

  // Fault injection: set real flags BEFORE the pipeline runs (§24).
  if (scenario === 'detector_failure') setFault('detector_timeout', true);
  if (scenario === 'payment_timeout') setFault('action_executor_timeout', true);

  try {
    const ctx = buildDemoEvent(scenario);
    const eventId = `demo_${scenario}_${Date.now()}_${uuidv4().slice(0, 8)}`;
    const response = await riskPipeline.process(ctx.event, eventId);
    res.json({ ...response, demo_meta: ctx.meta || null });
  } finally {
    // Always clear injected faults — one-shot per request.
    setFault('detector_timeout', false);
    setFault('action_executor_timeout', false);
  }
});

/** Replay the previous pipeline run for a scenario — demonstrates idempotency. */
router.post('/simulate/:scenario/replay', async (req: Request, res: Response) => {
  const scenario = req.params.scenario as DemoScenario;
  if (!SCENARIOS.includes(scenario)) {
    return res.status(400).json({ error: `unknown scenario: ${scenario}` });
  }

  // Same event_id + action => same idempotency key => cached result returned.
  const ctx = buildDemoEvent(scenario);
  const eventId = `demo_replay_${scenario}`;
  const response = await riskPipeline.process(ctx.event, eventId);

  // Show the raw idempotency lookup for the executed action, if any.
  const key = computeIdempotencyKey({
    merchant_id: ctx.event.merchant_id,
    module: ctx.event.module,
    event_id: eventId,
    action: response.agent?.recommended_action || 'none',
  });
  const cached = await idempotencyManager.check(key);

  res.json({ ...response, idempotency_probe: { key: key.slice(0, 16) + '…', cached_result_exists: cached !== null } });
});

router.get('/faults', (_req: Request, res: Response) => {
  res.json({ ...faultInjection, note: 'fault-injection flags (cleared after each request)' });
});

router.get('/audit/summary', async (_req: Request, res: Response) => {
  res.json(await auditService.stats());
});

export { router as demoRoutes };
