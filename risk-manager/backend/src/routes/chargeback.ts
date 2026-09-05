import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { riskPipeline } from '../services/container';
import { Dispute } from '../types';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

const bodySchema = z.object({
  dispute_id: z.string().min(1),
  merchant_id: z.string().min(1),
  reason_code: z.string().min(1),
  amount: z.number().positive(),
  respond_by: z.string().min(1),
  available_evidence: z.array(z.string()).default([]),
  event_id: z.string().optional(),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  }

  const dispute = parsed.data as unknown as Dispute;
  const response = await riskPipeline.process(
    { module: 'chargeback', merchant_id: dispute.merchant_id, dispute },
    parsed.data.event_id || `evt_${uuidv4()}`
  );
  res.json(response);
});

export { router as chargebackRoutes };
