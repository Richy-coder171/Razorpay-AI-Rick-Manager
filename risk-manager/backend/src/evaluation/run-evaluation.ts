/* Evaluation CLI entry — kept for compatibility; logic lives in fraudSpike.ts */
import { runEvaluation } from './fraudSpike';

try {
  runEvaluation();
} catch (err) {
  console.error(`Evaluation failed: ${(err as Error).message}`);
  process.exit(1);
}
