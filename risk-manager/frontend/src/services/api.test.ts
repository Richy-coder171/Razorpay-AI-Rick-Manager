import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  simulateNormal,
  simulateFraudSpike,
  simulateReturnRisk,
  simulateAbuseRing,
  simulateChargeback,
  simulateDetectorFailure,
  fetchAuditLog,
} from './api';

/**
 * Frontend contract test — pins the exact bug class that broke the live demo:
 * the v1 frontend called dash-named scenarios while the backend served
 * snake_case. Every URL and the x-api-key header are asserted here.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  );
  vi.stubGlobal('fetch', fetchMock);
});

const SCENARIO_URLS: Array<[string, () => Promise<unknown>, string]> = [
  ['normal', simulateNormal, '/api/demo/simulate/normal_traffic'],
  ['fraud', simulateFraudSpike, '/api/demo/simulate/fraud_spike'],
  ['return', simulateReturnRisk, '/api/demo/simulate/return_risk'],
  ['abuse', simulateAbuseRing, '/api/demo/simulate/abuse_ring'],
  ['chargeback', simulateChargeback, '/api/demo/simulate/chargeback'],
  ['detector failure', simulateDetectorFailure, '/api/demo/simulate/detector_failure'],
];

describe.each(SCENARIO_URLS)('api contract: %s', (_label, fn, expectedUrl) => {
  it(`POSTs to ${expectedUrl} with the x-api-key header`, async () => {
    await fn();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(expectedUrl);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'x-api-key': expect.any(String) });
  });
});

describe('api contract: audit log', () => {
  it('GETs /api/audit with server-side filters', async () => {
    await fetchAuditLog({ module: 'fraud_spike', escalated: true, limit: 50 });
    const [url] = fetchMock.mock.calls[0];
    expect(url.startsWith('/api/audit?')).toBe(true);
    expect(url).toContain('module=fraud_spike');
    expect(url).toContain('escalated=true');
    expect(url).toContain('limit=50');
  });
});
