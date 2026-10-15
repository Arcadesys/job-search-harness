import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tempRoot } from '../fixtures/temp-root';

test('collection health, recoverable exclusions, rendered review, keyboard and reflow', async ({ page }, info) => {
  const root = await tempRoot('workflow-browser-');
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/jobdesk-workflow-server.ts'], {
    cwd: process.cwd(), env: { ...process.env, JOBDESK_TEST_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const runtime: any = await new Promise((resolve, reject) => {
      let output = '', stderr = '';
      child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('\n')) {
        try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
      } });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject); child.on('exit', (code) => { if (code) reject(new Error(stderr)); });
    });
    const launch: any = await new Promise((resolve, reject) => {
      const req = request({ socketPath: runtime.socketPath, path: '/rpc', method: 'POST', headers: { Host: 'jobdesk', 'Content-Type': 'application/json' } }, (res) => {
        let output = ''; res.on('data', (chunk) => { output += chunk; }); res.on('end', () => { try { resolve(JSON.parse(output).data); } catch (error) { reject(error); } });
      }); req.on('error', reject); req.end(JSON.stringify({ method: 'browser.open', args: [] }));
    });
    const url = new URL(launch.url); url.pathname = '/jobs/workflow';
    await page.goto(url.href);
    await expect(page).toHaveTitle(/Job/);
    await expect(page.getByRole('heading', { name: 'Discovery and preparation', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Built In Chicago — Partial' })).toBeVisible();
    await expect(page.getByText(/first page only, at most 25 details/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume failed targets' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const evidence = path.join(tmpdir(), 'job-search-harness-durable-qa'); await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, `workflow-${info.project.name}.png`), fullPage: true });
    await page.getByRole('link', { name: 'Excluded jobs', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Excluded jobs', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Restore this job' }).click();
    await expect(page.getByText('Fictional Employer · Restored')).toBeVisible();
    await page.screenshot({ path: path.join(evidence, `restored-${info.project.name}.png`), fullPage: true });
    await page.getByRole('link', { name: 'Program Manager', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Prepared materials' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Employer résumé' })).toBeVisible();
    await expect(page.getByText(/Rendered review: Pending/)).toBeVisible();
    await page.getByRole('checkbox', { name: /I opened every exported page/ }).check();
    await page.getByRole('button', { name: 'Record rendered review' }).click();
    await expect(page.getByText(/Rendered review: Passed/)).toBeVisible();
    if (info.project.name === 'desktop') {
      await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    await page.screenshot({ path: path.join(evidence, `materials-${info.project.name}.png`), fullPage: true });
    for (const artifact of runtime.material.artifacts) await cp(artifact.path, path.join(evidence, `${artifact.kind}.pdf`));
    expect(errors).toEqual([]);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
    await rm(root, { recursive: true, force: true });
  }
});
