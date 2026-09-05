#!/usr/bin/env node
/**
 * Frontend prebuild (runs automatically before `npm run build` via the npm
 * prebuild lifecycle hook).
 *
 * The frontend imports @risk-manager/shared via the file: dependency
 * "file:../shared", so ../shared (with its BUILT dist/) must exist before
 * tsc/vite run. On hosts that mount the full repo (Vercel with Root
 * Directory = repo root, Render, Docker) this builds shared if needed; on a
 * normal local checkout it is a no-op because the dev workflow already
 * builds shared first.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// scripts/prebuild.cjs lives at frontend/scripts/ — the shared package is at
// the REPO root: <root>/shared = frontend/scripts/../../shared.
const sharedDir = path.resolve(__dirname, '..', '..', 'shared');

if (!fs.existsSync(sharedDir)) {
  console.error(
    'prebuild: ../shared not found.\n' +
      'If deploying on Vercel: set Root Directory to the REPO ROOT (not frontend/)\n' +
      'so the shared/ package is included in the build context.'
  );
  process.exit(1);
}

const distDir = path.join(sharedDir, 'dist');
if (fs.existsSync(distDir)) {
  console.log('prebuild: shared/dist present — nothing to do');
  process.exit(0);
}

console.log('prebuild: building @risk-manager/shared at', sharedDir);
execSync('npm install && npm run build', { cwd: sharedDir, stdio: 'inherit' });
console.log('prebuild: shared built');
