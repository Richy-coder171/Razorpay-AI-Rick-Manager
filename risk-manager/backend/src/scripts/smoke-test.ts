/**
 * Smoke test — the contract regression guard (run: `npm run smoke`).
 *
 * The v1→v2 rewrite broke the demo because the frontend and backend silently
 * disagreed on endpoint and scenario names. This script makes that class of
 * drift structurally loud: it hits the real server over HTTP and checks the
 * exact contract every page depends on, including that every demo scenario
 * returns an action that is a member of the module's allowlist (imported from
 * @risk-manager/shared — never hand-rolled here).
 *
 * Usage: start the backend (npm run dev), then `npm run smoke`
 * [base=http://localhost:3001] [key=demo-key]
 */

import { MODULE_ACTION_ALLOWLIST } from '@risk-manager/shared';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.SMOKE_API_KEY || process.env.DEMO_API_KEY || 'demo-key';

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

const GET_ROUTES = [
  '/api/health',
  '/api/dashboard',
  '/api/policy/config',
  '/api/evaluation/fraud-spike',
  '/api/audit?limit=5',
  // NOTE: /api/audit/verify is intentionally NOT here — it runs LAST, after
  // the simulations have appended records, so it verifies a POPULATED chain
  // (an empty-chain check once masked a real serialization bug).
] as const;

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, passed: true, detail });
  } catch (err) {
    results.push({ name, passed: false, detail: (err as Error).message });
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, { headers: { 'x-api-key': API_KEY } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function post(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main(): Promise<void> {
  console.log(`Smoke test against ${BASE}\n`);

  for (const route of GET_ROUTES) {
    await check(`GET ${route}`, async () => {
      const { status, body } = await get(route);
      expect(status >= 200 && status < 300, `expected 2xx, got ${status}: ${JSON.stringify(body)?.slice(0, 200)}`);
      expect(body !== null, `response body was not JSON`);
      return `2xx (${status})`;
    });
  }

  for (const scenario of SCENARIOS) {
    await check(`POST /api/demo/simulate/${scenario}`, async () => {
      const { status, body } = await post(`/api/demo/simulate/${scenario}`);
      expect(status >= 200 && status < 300, `expected 2xx, got ${status}: ${JSON.stringify(body)?.slice(0, 200)}`);

      const response = body as {
        type?: string;
        merchant_id?: string;
        detector?: { module?: string };
        agent?: { recommended_action?: string; module?: string };
        escalation?: { required?: boolean };
        audit_id?: string;
      };

      // The decision must exist and be bounded. detector_failure intentionally
      // omits the detector output (it failed) — fall back to the event type.
      const module = response.detector?.module ?? response.agent?.module ?? response.type?.replace('_event', '');
      expect(!!module, `no module in response: ${JSON.stringify(body)?.slice(0, 200)}`);
      expect(!!response.agent?.recommended_action, `agent.recommended_action missing`);
      const allowlist = MODULE_ACTION_ALLOWLIST[module as keyof typeof MODULE_ACTION_ALLOWLIST];
      expect(!!allowlist, `unknown module "${module}"`);
      expect(
        allowlist.includes(response.agent!.recommended_action!),
        `"${response.agent!.recommended_action}" not in allowlist for ${module}: [${allowlist.join(', ')}]`
      );
      // detector_failure escalates by design; every run must produce an audit record.
      expect(!!response.audit_id, `audit_id missing — no audit record was produced`);
      return `action=${response.agent!.recommended_action} in ${module} allowlist, audit ok`;
    });

    await check(`POST /api/demo/simulate/${scenario}/replay`, async () => {
      const { status, body } = await post(`/api/demo/simulate/${scenario}/replay`);
      expect(status >= 200 && status < 300, `expected 2xx, got ${status}: ${JSON.stringify(body)?.slice(0, 200)}`);
      const response = body as { agent?: { recommended_action?: string }; detector?: { module?: string } };
      const module = response.detector?.module;
      const allowlist = MODULE_ACTION_ALLOWLIST[module as keyof typeof MODULE_ACTION_ALLOWLIST];
      expect(!!allowlist && allowlist.includes(response.agent?.recommended_action ?? ''),
        `replay action "${response.agent?.recommended_action}" not in allowlist for ${module}`);
      return `replay 2xx, bounded action`;
    });
  }

  // Final gate: verify the POPULATED audit hash chain (the simulations above
  // just appended real records through the file-backed repository).
  await check('GET /api/audit/verify (populated chain)', async () => {
    const { status, body } = await get('/api/audit/verify');
    expect(status >= 200 && status < 300, `expected 2xx, got ${status}: ${JSON.stringify(body)?.slice(0, 200)}`);
    const verify = body as { valid?: boolean; records_checked?: number };
    expect(verify.valid === true, `chain reported INVALID: ${JSON.stringify(verify)}`);
    expect((verify.records_checked ?? 0) > 0, `chain had no records — verify ran against an empty chain`);
    return `valid, ${verify.records_checked} records`;
  });

  // Report
  const failed = results.filter((r) => !r.passed);
  for (const r of results) {
    const mark = r.passed ? 'PASS' : 'FAIL';
    console.log(`  [${mark}] ${r.name}${r.passed ? ` — ${r.detail}` : `\n         ${r.detail}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);

  if (failed.length > 0) {
    console.error(`\nSMOKE TEST FAILED — ${failed.length} check(s):`);
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log('Smoke test passed.');
}

main().catch((err) => {
  console.error(`Smoke test crashed: ${(err as Error).message}`);
  process.exit(1);
});
