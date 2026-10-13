import { tmpdir } from 'node:os';
import { defineConfig } from '@playwright/test';
import path from 'node:path';
export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'local-jobdesk.spec.ts',
  workers: 1,
  fullyParallel: false,
  outputDir: path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'job-search-harness-browser'),
  reporter: 'line',
  use: { browserName: 'chromium', trace: 'off' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 960 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
});
