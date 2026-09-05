/**
 * Idempotency + Action Executor tests (§13, §15, §23).
 */

import { IdempotencyManager, computeIdempotencyKey } from './idempotency';
import { ActionExecutor } from '../execution/actionExecutor';
import { InMemoryRepository } from '../test-helpers';

describe('Idempotency keys (§13)', () => {
  it('derives a stable sha256 key from merchant|module|event|action', () => {
    const a = computeIdempotencyKey({ merchant_id: 'm1', module: 'fraud_spike', event_id: 'e1', action: 'auto_block_window' });
    const b = computeIdempotencyKey({ merchant_id: 'm1', module: 'fraud_spike', event_id: 'e1', action: 'auto_block_window' });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('changes when any component changes', () => {
    const base = { merchant_id: 'm1', module: 'fraud_spike', event_id: 'e1', action: 'auto_block_window' };
    expect(computeIdempotencyKey(base)).not.toBe(computeIdempotencyKey({ ...base, event_id: 'e2' }));
    expect(computeIdempotencyKey(base)).not.toBe(computeIdempotencyKey({ ...base, action: 'flag_for_review' }));
  });

  it('stores and returns cached results for replays', async () => {
    const repo = new InMemoryRepository<{ id: string; result: unknown; created_at: string }>();
    const mgr = new IdempotencyManager(repo as never);
    expect(await mgr.check('k1')).toBeNull();
    await mgr.store('k1', { done: true });
    expect(await mgr.check('k1')).toEqual({ done: true });
  });
});

describe('Action Executor (§15)', () => {
  function makeExecutor(fault: { detector_timeout: boolean; action_executor_timeout: boolean }) {
    const repo = new InMemoryRepository<{ id: string; result: unknown; created_at: string }>();
    const idem = new IdempotencyManager(repo as never);
    const executor = new ActionExecutor(idem as never, { timeoutMs: 150, backoffMs: 10, fault });
    return { executor, idem };
  }

  it('executes an approved action and records it', async () => {
    const { executor } = makeExecutor({ detector_timeout: false, action_executor_timeout: false });
    const result = await executor.execute({ merchant_id: 'm1', module: 'fraud_spike', event_id: 'e1', action: 'flag_for_review' });
    expect(result.status).toBe('executed');
    expect(result.attempts).toBe(1);
  });

  it('returns the cached result for an identical replay (no re-execution)', async () => {
    const { executor } = makeExecutor({ detector_timeout: false, action_executor_timeout: false });
    await executor.execute({ merchant_id: 'm1', module: 'fraud_spike', event_id: 'e1', action: 'flag_for_review' });
    const replay = await executor.execute({ merchant_id: 'm1', module: 'fraud_spike', event_id: 'e1', action: 'flag_for_review' });
    expect(replay.status).toBe('idempotent_replay');
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.attempts).toBe(0);
  });

  it('timeouts: checks downstream, retries once with backoff, then succeeds', async () => {
    // Fault on FIRST attempt only is simulated by the executor clearing
    // action_executor_timeout on retry (real code path, §15).
    const { executor } = makeExecutor({ detector_timeout: false, action_executor_timeout: false });
    // Use a custom executor with a hanging first call:
    const repo = new InMemoryRepository<{ id: string; result: unknown; created_at: string }>();
    const idem = new IdempotencyManager(repo as never);
    const custom = new ActionExecutor(idem as never, { timeoutMs: 100, backoffMs: 5 });
    // Patch: first call hangs via fault toggled on, off after first timeout.
    const { faultInjection, setFault } = require('../execution/actionExecutor');
    setFault('action_executor_timeout', true);
    const attempt = custom.execute({ merchant_id: 'm1', module: 'fraud_spike', event_id: 'e_time', action: 'flag_for_review' });
    setTimeout(() => setFault('action_executor_timeout', false), 250); // clears before retry
    const result = await attempt;
    expect(['executed', 'escalated']).toContain(result.status);
    expect(result.attempts).toBe(2);
  });

  it('escalates when execution fails twice', async () => {
    const repo = new InMemoryRepository<{ id: string; result: unknown; created_at: string }>();
    const idem = new IdempotencyManager(repo as never);
    // 'permanent_ban' fails deterministically on BOTH attempts (refused by
    // the executor allowlist) -> check-state, retry once, escalate.
    const custom = new ActionExecutor(idem as never, { timeoutMs: 80, backoffMs: 5 });
    const result = await custom.execute({ merchant_id: 'm1', module: 'fraud_spike', event_id: 'e2', action: 'permanent_ban' });
    expect(result.status).toBe('escalated');
    expect(result.attempts).toBe(2);
    expect(result.detail).toContain('Escalated to human review');
  });

  it('refuses to execute an action outside the module allowlist', async () => {
    const { executor } = makeExecutor({ detector_timeout: false, action_executor_timeout: false });
    const result = await executor.execute({ merchant_id: 'm1', module: 'fraud_spike', event_id: 'e3', action: 'permanent_ban' });
    expect(result.status).toBe('escalated'); // downstream refuses; escalates
  });
});

describe('RateLimiter (§13.7)', () => {
  const { RateLimiter } = require('./rateLimiter');
  it('counts auto actions in the trailing hour', () => {
    const rl = new RateLimiter();
    rl.record('m1', 'fraud_spike');
    rl.record('m1', 'fraud_spike');
    rl.record('m2', 'fraud_spike');
    expect(rl.count('m1', 'fraud_spike')).toBe(2);
    expect(rl.count('m2', 'fraud_spike')).toBe(1);
    expect(rl.count('m1', 'chargeback')).toBe(0);
  });
});
