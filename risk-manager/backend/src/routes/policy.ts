import { Router, Request, Response } from 'express';
import { policyEngine } from '../services/container';

const router = Router();

/** Read-only policy config — judges can see live thresholds. */
router.get('/config', (_req: Request, res: Response) => {
  res.json(policyEngine.getConfig());
});

export { router as policyRoutes };
