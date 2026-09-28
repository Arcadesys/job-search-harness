import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { tmpdir } from 'node:os';
export default defineConfig({
  testDir: './tests/browser', testMatch: 'truth-review.spec.ts', workers: 1, fullyParallel: false,
  outputDir: path.join(tmpdir(), 'work-truth-review-browser'), reporter: 'line',
  use: { baseURL: 'http://127.0.0.1:3101', browserName: 'chromium' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1536, height: 1024 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
    { name: 'narrow', use: { viewport: { width: 320, height: 720 } } },
  ],
  webServer: { command: 'npx tsx tests/fixtures/truth-review-server.ts', url: 'http://127.0.0.1:3101', reuseExistingServer: !process.env.CI, timeout: 60000 },
});
