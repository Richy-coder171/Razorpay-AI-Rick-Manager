/**
 * Service wiring (composition root): single instances shared across requests.
 */

import { AuditService } from '../audit';
import { createRepository } from '../models/repository';
import { AuditRecord, ChargebackResult } from '../types';
import { IdempotencyManager, IdempotencyRecord, PolicyEngine, RateLimiter } from '../policy';
import { ActionExecutor } from '../execution';
import { RiskManagerAgent } from '../agents/riskManagerAgent';
import { RiskPipeline } from './riskPipeline';
import { WebhookHandler } from '../razorpay';
import { getPaymentProvider } from '../razorpay';
import { config } from '../config';

const auditRepo = createRepository<AuditRecord>('audit_log', 'audit-log.json');
export const auditService = new AuditService(auditRepo);

const idempotencyRepo = createRepository<IdempotencyRecord>('idempotency', 'idempotency.json');
export const idempotencyManager = new IdempotencyManager(idempotencyRepo);

export const rateLimiter = new RateLimiter();

export const policyEngine = new PolicyEngine(undefined, {
  getAutoActionCount: (merchantId, module) => rateLimiter.count(merchantId, module),
  // Policy check 8 (chargeback required evidence): the detector reports
  // missing_evidence_types as a set difference against its own taxonomy;
  // the policy layer requires that list to be empty for auto-actions. This
  // reuses the detector's computation — no second evidence source exists.
  getMissingEvidence: (detectorOutput) =>
    detectorOutput.module === 'chargeback'
      ? (detectorOutput as ChargebackResult).missing_evidence_types ?? []
      : [],
});

export const actionExecutor = new ActionExecutor(idempotencyManager, { timeoutMs: 2000, backoffMs: 250 });

export const riskManagerAgent = new RiskManagerAgent();

export const riskPipeline = new RiskPipeline({
  agent: riskManagerAgent,
  policy: policyEngine,
  rateLimiter,
  executor: actionExecutor,
  audit: auditService,
});

export const webhookHandler = new WebhookHandler(idempotencyManager);
export const paymentProvider = getPaymentProvider();

export function providerModeBanner(): { provider: string; mode: string; live: boolean } {
  return {
    provider: paymentProvider.info.name,
    mode: paymentProvider.info.mode,
    live: paymentProvider.info.name === 'razorpay' && paymentProvider.info.mode === 'live',
  };
}

export const appConfig = config;
