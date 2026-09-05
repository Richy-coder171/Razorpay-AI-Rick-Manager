/**
 * Action Executor (§15) — the ONLY code allowed to touch order/account/payment
 * state, and only for actions that are BOTH allowlisted AND policy-approved.
 *
 * Failure recovery:
 *  - Check actual downstream state before retrying (never assume timeout = no-op).
 *  - Idempotency key: if a result is already recorded, return it.
 *  - Otherwise retry once with backoff, then escalate. Never blind-retry.
 *
 * Fault injection flags (demo buttons §24) route through the SAME code path:
 * simulate_payment_timeout makes the downstream call hang, demonstrating the
 * check-then-retry-then-escalate sequence with audit records.
 */

import { ModuleName } from '../types';
import { IdempotencyManager, computeIdempotencyKey } from '../policy';

export interface ExecutionRequest {
  merchant_id: string;
  module: ModuleName;
  event_id: string;
  action: string;
  /** Human-readable summary of what executing this action means downstream. */
  payload?: Record<string, unknown>;
}

export interface ExecutionResult {
  status: 'executed' | 'idempotent_replay' | 'escalated';
  action: string;
  detail: string;
  idempotency_key: string;
  attempts: number;
  idempotent_replay?: boolean;
}

// Fault-injection switches (demo mode §24) — real flags, real code paths.
export interface FaultInjection {
  detector_timeout: boolean;
  action_executor_timeout: boolean;
}

export const faultInjection: FaultInjection = {
  detector_timeout: false,
  action_executor_timeout: false,
};

export function setFault(kind: keyof FaultInjection, on: boolean): void {
  faultInjection[kind] = on;
}

export class ActionExecutor {
  /** Actions this executor is willing to run at all (defense in depth). */
  private static EXECUTABLE_ACTIONS: Record<ModuleName, string[]> = {
    fraud_spike: ['auto_block_window', 'flag_for_review', 'no_action'],
    return_risk: ['allow_cod', 'require_prepaid', 'flag_for_manual_review', 'block_order'],
    abuse_ring: ['flag_ring_for_investigation', 'restrict_accounts_pending_review', 'no_action'],
    chargeback: ['auto_contest_full', 'auto_contest_partial', 'draft_for_human_review', 'recommend_accept_loss'],
  };

  constructor(
    private idempotency: IdempotencyManager,
    private opts: { timeoutMs?: number; backoffMs?: number; fault?: FaultInjection } = {}
  ) {}

  static isExecutable(module: ModuleName, action: string): boolean {
    return ActionExecutor.EXECUTABLE_ACTIONS[module]?.includes(action) ?? false;
  }

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    const key = computeIdempotencyKey({
      merchant_id: req.merchant_id,
      module: req.module,
      event_id: req.event_id,
      action: req.action,
    });

    // 0. Idempotency: already executed? Return the cached result (§13, §19).
    const cached = await this.idempotency.check(key);
    if (cached !== null) {
      return {
        status: 'idempotent_replay',
        action: req.action,
        detail: 'This exact (merchant, module, event, action) was already executed; returning recorded result without re-executing.',
        idempotency_key: key,
        attempts: 0,
        idempotent_replay: true,
      };
    }

    const faults = this.opts.fault || faultInjection;

    // 1. First attempt (with timeout).
    try {
      const result = await this.withTimeout(this.downstreamCall(req, faults), this.opts.timeoutMs ?? 3000);
      await this.idempotency.store(key, result);
      return {
        status: 'executed',
        action: req.action,
        detail: `Executed ${req.action} via payment provider adapter. Downstream confirmed: ${result}`,
        idempotency_key: key,
        attempts: 1,
      };
    } catch (firstErr) {
      // 2. CHECK ACTUAL DOWNSTREAM STATE before retrying (§15) — don't
      //    assume the failure means nothing happened.
      const settled = await this.probeDownstreamState(key, req);
      if (settled !== null) {
        await this.idempotency.store(key, settled);
        return {
          status: 'executed',
          action: req.action,
          detail: `First attempt timed out but downstream state check confirmed the action HAD been applied; recorded as executed (no blind retry).`,
          idempotency_key: key,
          attempts: 1,
        };
      }

      // 3. Retry once with backoff, then escalate.
      await this.backoff(this.opts.backoffMs ?? 300);
      try {
        const result = await this.withTimeout(this.downstreamCall(req, { ...faults, action_executor_timeout: false }), this.opts.timeoutMs ?? 3000);
        await this.idempotency.store(key, result);
        return {
          status: 'executed',
          action: req.action,
          detail: `First attempt failed (${(firstErr as Error).message}); verified no downstream effect, retried once successfully.`,
          idempotency_key: key,
          attempts: 2,
        };
      } catch (secondErr) {
        return {
          status: 'escalated',
          action: req.action,
          detail: `Execution failed twice (${(secondErr as Error).message}). Escalated to human review; downstream state left as-is pending investigation.`,
          idempotency_key: key,
          attempts: 2,
        };
      }
    }
  }

  /**
   * The actual downstream state mutation. In mock provider mode this records
   * the action against the mock provider's state; with PAYMENT_PROVIDER=
   * razorpay it would call the corresponding Razorpay Test Mode API. Never
   * called for actions outside the executor allowlist (checked by callers and
   * by policy approval upstream — this is the last line, so check again).
   */
  private async downstreamCall(req: ExecutionRequest, faults: FaultInjection): Promise<string> {
    if (!ActionExecutor.isExecutable(req.module, req.action)) {
      throw new Error(`action ${req.action} is not executable for module ${req.module}`);
    }

    if (faults.action_executor_timeout) {
      // Real fault path: hang until the surrounding timeout fires. A
      // never-resolving promise (no timer) avoids leaking handles.
      await new Promise<never>(() => {});
    }

    // Mock/test-mode downstream mutation. Synthetic ids only.
    return `${req.action} applied for ${req.merchant_id} (test-mode downstream)`;
  }

  /**
   * Probe whether the first (timed-out) attempt actually landed downstream.
   * With the mock adapter this checks the idempotency store; a real adapter
   * would query the provider's API by idempotency key.
   */
  private async probeDownstreamState(key: string, _req: ExecutionRequest): Promise<string | null> {
    const existing = await this.idempotency.check(key);
    return existing !== null ? String(existing) : null;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`downstream timeout after ${ms}ms`)), ms)),
    ]);
  }

  private backoff(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
