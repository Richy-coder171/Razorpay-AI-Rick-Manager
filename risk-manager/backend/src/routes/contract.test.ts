/**
 * Contract regression tests — the exact bug class the v1→v2 rewrite shipped:
 * the frontend called one set of route/scenario names while the backend served
 * another. These tests pin the contract at the HTTP level (supertest, no
 * network) so a rename on either side fails CI instead of a live demo.
 *
 * Pinned contract (see also src/scripts/smoke-test.ts for the live variant):
 *  - GET /api/dashboard           (canonical dashboard summary)
 *  - GET /api/policy/config       (canonical policy config)
 *  - POST /api/demo/simulate/:scenario with the seven snake_case scenario ids
 *  - every scenario returns an agent action inside the module's allowlist
 *    (imported from @risk-manager/shared — never re-declared here)
 *  - non-exempt routes require x-api-key; /health, /dashboard, /policy,
 *    /evaluation are exempt so the UI renders cold
 */

import request from 'supertest';
import { MODULE_ACTION_ALLOWLIST } from '../types';
import { setFault } from '../execution';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Application } from 'express';

// Isolate the file-backed repositories BEFORE the app (and its module-level
// container singletons) load — otherwise these tests append to the real
// demo audit log and corrupt the hash chain for any concurrently running server.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-contract-'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app: Application = require('../index').default;

const SCENARIOS = [
  'normal_traffic',
  'fraud_spike',
  'return_risk',
  'abuse_ring',
  'chargeback',
  'detector_failure',
  'invalid_data',
  'payment_timeout',
] as const;

describe('HTTP contract (route-level regression tests)', () => {
  afterAll(() => {
    // Faults are one-shot per request in the demo route, but be explicit.
    setFault('detector_timeout', false);
    setFault('action_executor_timeout', false);
  });

  it('serves the canonical dashboard at GET /api/dashboard', async () => {
    const res = await request(app).get('/api/dashboard').expect(200);
    expect(res.body.totals).toBeDefined();
    expect(typeof res.body.totals.decisions).toBe('number');
    expect(Array.isArray(res.body.recent_decisions)).toBe(true);
  });

  it('serves the policy config at GET /api/policy/config', async () => {
    const res = await request(app).get('/api/policy/config').expect(200);
    expect(res.body.version).toBe('policy-v2');
    expect(res.body.modules.fraud_spike.allowed_actions).toContain('auto_block_window');
  });

  it('serves health without an API key', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(['fitted', 'bootstrap_default']).toContain(res.body.fraud_spike_calibration);
  });

  it('rejects protected routes without the x-api-key header', async () => {
    await request(app).get('/api/audit').expect(401);
    await request(app).post('/api/demo/simulate/normal_traffic').expect(401);
  });

  it('exempts dashboard/policy/evaluation from the API key so the UI renders cold', async () => {
    await request(app).get('/api/dashboard').expect(200);
    await request(app).get('/api/policy/config').expect(200);
    await request(app).get('/api/evaluation/fraud-spike').expect(200);
  });

  it.each(SCENARIOS)(
    'POST /api/demo/simulate/%s runs end-to-end with a bounded action',
    async (scenario) => {
      const res = await request(app)
        .post(`/api/demo/simulate/${scenario}`)
        .set('x-api-key', 'demo-key')
        .expect(200);

      expect(res.body.audit_id).toBeDefined();
      expect(res.body.stages.map((s: { stage: string }) => s.stage)).toContain('audit');

      const module = res.body.detector?.module ?? res.body.agent?.module ?? res.body.type?.replace('_event', '');
      expect(module).toBeDefined();
      const allowlist = MODULE_ACTION_ALLOWLIST[module as keyof typeof MODULE_ACTION_ALLOWLIST];
      expect(allowlist).toBeDefined();
      expect(allowlist).toContain(res.body.agent.recommended_action);
    },
      // detector_failure/invalid_data/payment_timeout exercise real failure
      // paths (injected timeout, insufficient_data, executor timeout) and may
      // wait out the 5s timeouts by design — allow up to 15s per scenario.
    15_000
  );

  it('rejects unknown scenario names with the available list (rename drift fails loudly)', async () => {
    const res = await request(app)
      .post('/api/demo/simulate/fraud-spike') // v1 name with a dash — must NOT work
      .set('x-api-key', 'demo-key')
      .expect(400);
    expect(res.body.available).toEqual(SCENARIOS);
  });

  it('GET /api/audit returns the filterable record list', async () => {
    const res = await request(app).get('/api/audit?limit=5').set('x-api-key', 'demo-key').expect(200);
    expect(Array.isArray(res.body.records)).toBe(true);
    expect(res.body.records.length).toBeLessThanOrEqual(5);
  });

  it('POST /api/razorpay/order fails honestly (502) when Razorpay keys are not configured — never fakes an order', async () => {
    // In the test environment no real Razorpay keys exist. The endpoint must
    // surface the real error, NOT return a fabricated order id.
    const res = await request(app).post('/api/razorpay/order').set('x-api-key', 'demo-key');
    if (res.status === 200) {
      // Keys configured in this environment: then the order MUST look real.
      expect(res.body.id).toMatch(/^order_/);
      expect(res.body.amount).toBe(10000);
      expect(res.body.test_mode).toBe(true);
      expect(res.body.key_id).toMatch(/^rzp_test_/);
      // the key SECRET must NEVER appear in the response
      expect(JSON.stringify(res.body)).not.toContain('key_secret');
    } else {
      expect(res.status).toBe(502);
      expect(res.body.error).toBeDefined();
      expect(JSON.stringify(res.body)).not.toMatch(/order_[A-Za-z0-9]{10,}/); // no fabricated order id
    }
  });

  it('GET /api/razorpay/payments lists webhook-verified payments (never fabricated ones)', async () => {
    const res = await request(app).get('/api/razorpay/payments').set('x-api-key', 'demo-key').expect(200);
    expect(Array.isArray(res.body.payments)).toBe(true);
    // Anything listed must have come from a verified webhook: real Razorpay ids.
    for (const p of res.body.payments) {
      expect(p.id).toMatch(/^pay_/);
      expect(p.order_id).toMatch(/^order_/);
    }
  });
});
