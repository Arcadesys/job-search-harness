import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';
// Runs the staged desktop app (npm run desktop:stage first). Linux CI wraps it in xvfb-run.
export default defineConfig({
  testDir: './tests/desktop',
  workers: 1,
  fullyParallel: false,
  outputDir: path.join(tmpdir(), 'job-search-harness-desktop'),
  reporter: 'line',
});
