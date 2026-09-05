/**
 * Frozen-dataset generator (§7.6, §18).
 * Generates the chronological 60/20/20 timeline ONCE with a fixed seed and
 * writes train/dev/held-out-test JSON files plus a SHA-256 checksum manifest.
 * The held-out test file is pinned; `npm run evaluate` reads it and refuses to
 * regenerate it silently.
 */

import * as fs from 'fs';
import * as path from 'path';
import { generateTimeline, LabeledWindow } from './generator';
import { sha256Hex } from '../utils/crypto';

export interface FrozenDataset {
  dataset_name: string;
  seed: number;
  split: 'train' | 'dev' | 'test';
  window_count: number;
  positive_count: number;
  windows: LabeledWindow[];
}

export const DATASET_NAME = 'fraud-spike-held-out-test-v1';
const DEFAULT_SEED = 42;
const DEFAULT_TOTAL = 1500; // 60/20/20 -> 900 train, 300 dev, 300 test

export function generateSplitDatasets(seed = DEFAULT_SEED, total = DEFAULT_TOTAL): {
  train: FrozenDataset;
  dev: FrozenDataset;
  test: FrozenDataset;
} {
  // Single chronological timeline; split by position, never shuffled (§7.6).
  const timeline = generateTimeline({ seed, windowCount: total, spikeRate: 0.1 });
  const n = timeline.windows.length;
  const trainEnd = Math.floor(n * 0.6);
  const devEnd = Math.floor(n * 0.8);

  const make = (split: 'train' | 'dev' | 'test', windows: LabeledWindow[]): FrozenDataset => ({
    dataset_name: `${DATASET_NAME}-${split}`,
    seed,
    split,
    window_count: windows.length,
    positive_count: windows.filter((w) => w.is_fraud_spike).length,
    windows,
  });

  return {
    train: make('train', timeline.windows.slice(0, trainEnd)),
    dev: make('dev', timeline.windows.slice(trainEnd, devEnd)),
    test: make('test', timeline.windows.slice(devEnd)),
  };
}

export function writeFrozenDatasets(dataDir: string, seed = DEFAULT_SEED, total = DEFAULT_TOTAL): {
  files: Array<{ file: string; sha256: string; windows: number; positives: number; split: string }>;
} {
  const { train, dev, test } = generateSplitDatasets(seed, total);
  fs.mkdirSync(path.resolve(dataDir, 'test'), { recursive: true });

  const manifest: Array<{ file: string; sha256: string; windows: number; positives: number; split: string }> = [];
  const entries: Array<{ split: string; data: FrozenDataset }> = [
    { split: 'train', data: train },
    { split: 'dev', data: dev },
    { split: 'test', data: test },
  ];

  for (const { split, data } of entries) {
    const file = path.join(dataDir, 'test', split === 'test' ? 'held-out-test-v1.json' : `train-${split}-v1.json`);
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(file, json);
    manifest.push({
      file: path.relative(process.cwd(), file).split(path.sep).join('/'),
      sha256: sha256Hex(json),
      windows: data.window_count,
      positives: data.positive_count,
      split,
    });
  }

  const manifestPath = path.join(dataDir, 'test', 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ dataset_name: DATASET_NAME, seed, generated_at: new Date().toISOString(), files: manifest }, null, 2));
  return { files: manifest };
}

// CLI: npm run generate-data -- --seed 42
if (require.main === module) {
  const args = process.argv.slice(2);
  const seedArg = args.indexOf('--seed');
  const seed = seedArg !== -1 && args[seedArg + 1] ? Number.parseInt(args[seedArg + 1], 10) : DEFAULT_SEED;
  const dataDir = path.resolve(__dirname, '../../data');
  const result = writeFrozenDatasets(dataDir, seed);
  console.log(`Frozen datasets written (seed=${seed}):`);
  for (const f of result.files) {
    console.log(`  ${f.file} — ${f.windows} windows (${f.positives} positives) sha256=${f.sha256.slice(0, 16)}…`);
  }
}
