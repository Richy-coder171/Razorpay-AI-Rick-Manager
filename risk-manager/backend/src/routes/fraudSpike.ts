import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { riskPipeline } from '../services/container';
import { extractWindowFeatures, WindowFeatures } from '../features';
import { Transaction } from '../types';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

const transactionSchema = z.object({
  id: z.string().min(1),
  merchant_id: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().default('INR'),
  status: z.enum(['captured', 'failed', 'pending']),
  payment_mode: z.enum(['cod', 'prepaid']),
  customer_id: z.string().min(1),
  card_hash: z.string().optional(),
  device_fingerprint: z.string().optional(),
  ip_hash: z.string().optional(),
  region: z.string().optional(),
  created_at: z.string().min(1),
});

const bodySchema = z.object({
  window_start: z.string().optional(),
  window_end: z.string().optional(),
  transactions: z.array(transactionSchema).min(1),
  prior_window_features: z.array(z.record(z.unknown())).optional(), // computed server-side if absent
  event_id: z.string().optional(),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  }

  const { transactions, window_start, window_end, event_id } = parsed.data;
  const merchantId = transactions[0].merchant_id as string;

  const priorFeatures: WindowFeatures[] = (parsed.data.prior_window_features as unknown as WindowFeatures[]) || [];
  const current = extractWindowFeatures(transactions, window_start, window_end);

  // NOTE: if the caller did not supply trailing features, pass empty — the
  // detector will report insufficient_data and the pipeline escalates (§0:
  // missing input means escalate, never guess).

  const response = await riskPipeline.process(
    {
      module: 'fraud_spike',
      merchant_id: merchantId,
      window: transactions as Transaction[],
      prior_window_features: priorFeatures,
      window_start,
      window_end,
    },
    event_id || `evt_${uuidv4()}`
  );

  void current;
  res.json(response);
});

export { router as fraudSpikeRoutes };
