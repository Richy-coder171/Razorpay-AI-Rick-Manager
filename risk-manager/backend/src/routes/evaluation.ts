import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { EvaluationMetrics } from '../types';

const router = Router();

const RESULTS_DIR = path.resolve(__dirname, '../../evaluation/fraud-spike/results');

router.get('/fraud-spike', (_req: Request, res: Response) => {
  const metricsFile = path.join(RESULTS_DIR, 'metrics.json');
  const confusionFile = path.join(RESULTS_DIR, 'confusion_matrix.json');

  if (!fs.existsSync(metricsFile)) {
    // HONEST state (§7.6): never fabricate numbers.
    return res.json({
      status: 'not_evaluated',
      message: 'not yet evaluated — run npm run evaluate',
      hint: 'cd backend && npm run evaluate',
    });
  }

  const metrics = JSON.parse(fs.readFileSync(metricsFile, 'utf8')) as EvaluationMetrics;
  const confusion = fs.existsSync(confusionFile)
    ? JSON.parse(fs.readFileSync(confusionFile, 'utf8'))
    : null;

  res.json({ status: 'ok', ...metrics, confusion_matrix_file: confusion });
});

export { router as evaluationRoutes };
