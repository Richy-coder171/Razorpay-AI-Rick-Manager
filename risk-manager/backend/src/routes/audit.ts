import { Router, Request, Response } from 'express';
import { auditService } from '../services/container';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const records = await auditService.getRecords({
    module: req.query.module as string | undefined,
    action: req.query.action as string | undefined,
    confidence: req.query.confidence as string | undefined,
    escalated: req.query.escalated === 'true' ? true : req.query.escalated === 'false' ? false : undefined,
    failure_state: req.query.failure_state as string | undefined,
    startDate: req.query.start_date as string | undefined,
    endDate: req.query.end_date as string | undefined,
    limit: req.query.limit ? Number.parseInt(req.query.limit as string, 10) : undefined,
  });
  res.json({ records, total: records.length });
});

router.get('/verify', async (_req: Request, res: Response) => {
  const result = await auditService.verifyChain();
  const status = result.valid ? 200 : 409;
  res.status(status).json(result);
});

router.get('/stats', async (_req: Request, res: Response) => {
  res.json(await auditService.stats());
});

router.get('/:id', async (req: Request, res: Response) => {
  const record = await auditService.getRecordById(req.params.id);
  if (!record) {
    return res.status(404).json({ error: 'audit record not found' });
  }
  res.json(record);
});

export { router as auditRoutes };
