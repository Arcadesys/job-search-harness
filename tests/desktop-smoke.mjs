// Runs the actual packaged macOS executable with an isolated private store.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { brokerCall } from '../services/jobdesk/client.ts';
import { brokerEndpoint } from '../services/jobdesk/paths.mjs';
import { stopDetachedOwner } from '../services/jobdesk/owner-launch.ts';
import { sampleResume } from './fixtures/sample-resume.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const executablePath = process.argv[2] ?? path.join(repo, `dist/Job Search Harness-darwin-${process.arch}/Job Search Harness.app/Contents/MacOS/Job Search Harness`);
const root = await mkdtemp('/tmp/jh-desktop-');
const data = path.join(root, 'data');
const env = { ...process.env, JOBDESK_DATA_DIR: data, JOBDESK_DESKTOP_USER_DATA_DIR: path.join(root, 'browser'), JOBDESK_PORT: '0' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.JOBDESK_SOCKET;
let app;
const errors = [];
const launch = () => electron.launch({ executablePath, env, timeout: 40_000 });
const call = (method, args = []) => brokerCall(method, args, brokerEndpoint(data));
try {
  app = await launch();
  let page = await app.firstWindow({ timeout: 40_000 });
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const p = contents.getLastWebPreferences();
    return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
  });
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  const owner = JSON.parse(await readFile(path.join(data, 'owner.lock'), 'utf8'));
  await call('truth.importResume', [sampleResume]);
  const original = await call('truth.list');
  assert.ok(original.length > 0);
  const origin = new URL(page.url()).origin;
  for (const route of ['/jobs/settings', '/jobs/truths', '/jobs']) {
    await page.goto(origin + route);
    await expect(page.locator('main h1').first()).toBeVisible();
    const scan = await new AxeBuilder({ page }).setLegacyMode().withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(scan.violations.map(v => v.id), []);
  }
  // Real Electron zoom changes effective CSS viewport, unlike a CSS-only test.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1000, 900);
    window.webContents.setZoomFactor(2);
  });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(600);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const show = page.getByRole('button', { name: 'Show activity', exact: true });
  await show.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Assistant activity', exact: true });
  await expect(dialog.getByRole('button', { name: 'Close activity' })).toBeFocused();
  await page.keyboard.press('Tab');
  assert.ok(await dialog.evaluate(element => element.contains(document.activeElement)));
  await page.keyboard.press('Escape');
  await expect(show).toBeFocused();
  const capture = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await writeFile('/tmp/job-harness-electron-200-percent.png', Buffer.from(capture, 'base64'));
  const scan = await new AxeBuilder({ page }).setLegacyMode().withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(scan.violations.map(v => v.id), []);
  await app.close(); app = undefined;
  // Quit leaves the owned broker available to assistants; reopening reuses it.
  assert.equal((await call('health')).ok, true);
  app = await launch();
  page = await app.firstWindow({ timeout: 40_000 });
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  assert.equal(JSON.parse(await readFile(path.join(data, 'owner.lock'), 'utf8')).pid, owner.pid);
  assert.deepEqual(await call('truth.list'), original);
  await app.close(); app = undefined;
  // Stop only our temporary owner, then prove storage survives a new process.
  await stopDetachedOwner(data);
  app = await launch();
  page = await app.firstWindow({ timeout: 40_000 });
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  assert.notEqual(JSON.parse(await readFile(path.join(data, 'owner.lock'), 'utf8')).pid, owner.pid);
  assert.deepEqual(await call('truth.list'), original);
  assert.deepEqual(errors, []);
  const result = { packaged: executablePath, migrations: (await call('health')).migrations.length,
    checks: ['sandbox', 'navigation', 'WCAG A/AA', '200% zoom reflow', 'keyboard modal', 'owner reuse', 'persistence across owner restart'], errors };
  await writeFile('/tmp/job-harness-electron-checks.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (app) await app.close();
  await stopDetachedOwner(data);
  await rm(root, { recursive: true, force: true });
}
