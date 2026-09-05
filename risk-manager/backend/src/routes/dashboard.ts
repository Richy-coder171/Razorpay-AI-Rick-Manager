import { Router, Request, Response } from 'express';
import { auditService, providerModeBanner, appConfig } from '../services/container';
import { DashboardStats, AuditRecord } from '../types';

const router = Router();

/** Canonical dashboard summary: stats + recent decisions + top flagged windows. */
router.get('/', async (_req: Request, res: Response) => {
  const stats = await auditService.stats();
  const recent = await auditService.getRecords({ limit: 20 });

  // Amount at risk: sum of affected_transactions_value over flagged windows
  // from real audit records (computed, not asserted).
  let amountAtRisk = 0;
  const topFlagged: DashboardStats['top_flagged_windows'] = [];
  for (const r of recent as AuditRecord[]) {
    const det = r.detector_output as { affected_transactions_value?: number } | null;
    if (det && typeof det.affected_transactions_value === 'number' && det.affected_transactions_value > 0 && r.module === 'fraud_spike' && r.recommended_action !== 'no_action') {
      amountAtRisk += det.affected_transactions_value;
      topFlagged.push({
        window: r.input_reference,
        merchant_id: r.merchant_id,
        amount_flagged_inr: det.affected_transactions_value,
        probability: (det as { calibrated_probability?: number }).calibrated_probability ?? 0,
      });
    }
  }

  const byModule: DashboardStats['by_module'] = {};
  for (const r of recent as AuditRecord[]) {
    if (!byModule[r.module]) byModule[r.module] = { decisions: 0, escalated: 0, approved: 0, failed: 0 };
    byModule[r.module].decisions++;
    if (r.human_escalation) byModule[r.module].escalated++;
    if (r.policy_decision === 'approved') byModule[r.module].approved++;
    if (r.failure_state) byModule[r.module].failed++;
  }

  const response: DashboardStats & { provider_mode: ReturnType<typeof providerModeBanner>; db_driver: string } = {
    totals: {
      transactions: recent.length,
      amount_at_risk_inr: Math.round(amountAtRisk),
      active_investigations: recent.filter((r: AuditRecord) => r.recommended_action?.includes('flag') || r.recommended_action?.includes('investigation')).length,
      escalations: stats.escalated,
      decisions: stats.total,
    },
    by_module: byModule,
    recent_decisions: recent.slice(0, 10),
    top_flagged_windows: topFlagged.slice(0, 5),
    provider_mode: providerModeBanner(),
    db_driver: appConfig.db_driver,
  };

  res.json(response);
});

export { router as dashboardRoutes };
