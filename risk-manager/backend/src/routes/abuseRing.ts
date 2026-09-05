import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { riskPipeline } from '../services/container';
import { LinkedAccount } from '../types';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

const accountSchema = z.object({
  account_id: z.string().min(1),
  shared_device_hash: z.string().optional(),
  shared_phone_hash: z.string().optional(),
  shared_email_hash: z.string().optional(),
  shared_address_hash: z.string().optional(),
  shared_payment_identifier: z.string().optional(),
  shared_ip_hash: z.string().optional(),
  chargeback_count: z.number().int().min(0).optional(),
});

const bodySchema = z.object({
  merchant_id: z.string().min(1),
  anchor_account_id: z.string().min(1),
  accounts: z.array(accountSchema).min(1),
  event_id: z.string().optional(),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  }

  const response = await riskPipeline.process(
    {
      module: 'abuse_ring',
      merchant_id: parsed.data.merchant_id,
      accounts: parsed.data.accounts as LinkedAccount[],
      anchor_account_id: parsed.data.anchor_account_id,
    },
    parsed.data.event_id || `evt_${uuidv4()}`
  );
  res.json(response);
});

export { router as abuseRingRoutes };
