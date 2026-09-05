import { Router, Request, Response } from 'express';
import { createTestOrder, listVerifiedPayments } from '../razorpay/checkout';

const router = Router();

/** Create a REAL ₹100 (10000 paise) test order via the Razorpay Orders API. */
router.post('/order', async (_req: Request, res: Response) => {
  const result = await createTestOrder();
  if (!result.ok || !result.order) {
    return res.status(502).json({ error: result.error });
  }
  res.json(result.order); // id, amount, currency, key_id (public), test_mode
});

/** Payments recorded from signature-verified webhooks (newest first). */
router.get('/payments', async (_req: Request, res: Response) => {
  res.json({ payments: await listVerifiedPayments() });
});

export { router as razorpayRoutes };
