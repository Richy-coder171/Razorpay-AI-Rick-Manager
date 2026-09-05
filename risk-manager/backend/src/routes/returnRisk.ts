import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { riskPipeline } from '../services/container';
import { Order } from '../types';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

const orderSchema = z.object({
  order_id: z.string().min(1),
  merchant_id: z.string().min(1),
  customer_id: z.string().min(1),
  order_value: z.number().positive(),
  payment_mode: z.enum(['cod', 'prepaid']),
  delivery_address: z.object({
    serviceability: z.enum(['high', 'medium', 'low']),
    city: z.string(),
    state: z.string(),
    pincode: z.string(),
  }),
  customer_history: z.object({
    prior_returns: z.number().int().min(0),
    failed_deliveries: z.number().int().min(0),
    total_orders: z.number().int().min(0),
    account_age_days: z.number().int().min(0),
    similar_past_orders: z.array(z.object({ order_id: z.string(), outcome: z.enum(['delivered', 'returned', 'failed']) })).default([]),
  }),
  created_at: z.string(),
  status: z.enum(['pending', 'delivered', 'returned', 'failed']).optional(),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  }

  const order = { ...parsed.data, status: parsed.data.status || 'pending' } as Order;
  const response = await riskPipeline.process(
    { module: 'return_risk', merchant_id: order.merchant_id, order },
    (req.body as { event_id?: string }).event_id || `evt_${uuidv4()}`
  );
  res.json(response);
});

export { router as returnRiskRoutes };
