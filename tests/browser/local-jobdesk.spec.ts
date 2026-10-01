import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { request } from 'node:http';

async function launchSession(socketPath: string) {
  return new Promise<{ url: string }>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/rpc',
        method: 'POST',
        headers: { Host: 'jobdesk', 'Content-Type': 'application/json' },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(text).data);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ method: 'browser.open', args: [] }));
  });
}

test('local session, truthful approval, cancel/retry, lead review and large-text keyboard use', async ({
  page,
}, info) => {
  const root = await mkdtemp('/tmp/jobdesk-browser-');
  const processHandle = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/jobdesk-server.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, JOBDESK_TEST_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    const runtime = await new Promise<{ origin: string; socketPath: string }>((resolve, reject) => {
      let output = '',
        errors = '';
      processHandle.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('\n')) {
          try {
            resolve(JSON.parse(output.split('\n')[0]));
          } catch (error) {
            reject(error);
          }
        }
      });
      processHandle.stderr.on('data', (chunk) => (errors += chunk));
      processHandle.on('error', reject);
      processHandle.on('exit', (code) => {
        if (code) reject(new Error(`Fixture exited ${code}: ${errors}`));
      });
    });
    await page.goto(runtime.origin);
    await expect(page.getByRole('alert')).toContainText('local command');
    const launch = await launchSession(runtime.socketPath);
    const url = new URL(launch.url);
    url.pathname = '/jobs/truths';
    await page.goto(url.href);
    await expect(
      page.getByRole('heading', { name: 'Personal details', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Private · Local session')).toHaveText('Private · Local session');
    await expect(page).toHaveURL(`${runtime.origin}/jobs/truths`);
    const first = page.locator('.truthChoice input').first();
    await first.focus();
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Approve 1 selected' }).click();
    await expect(page.getByRole('status')).toContainText('1 truth approved');
    const row = page.locator('.truthRow').first();
    await row.getByRole('button', { name: /^Edit:/ }).click();
    await page
      .getByRole('textbox', { name: 'Claim', exact: true })
      .fill('Unsaved local fixture correction');
    await page.getByRole('link', { name: 'Today', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Save or cancel');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await row.getByRole('button', { name: /^Edit:/ }).click();
    await page
      .getByRole('textbox', { name: 'Claim', exact: true })
      .fill('Reviewed local fixture correction');
    await page.route('**/api/jobs/resume-truth', async (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Synthetic temporary failure' }),
          })
        : route.continue(),
    );
    await page.getByRole('button', { name: 'Save & approve' }).click();
    await expect(page.getByRole('alert')).toContainText('Synthetic temporary failure');
    await expect(page.getByRole('textbox', { name: 'Claim', exact: true })).toHaveValue(
      'Reviewed local fixture correction',
    );
    await page.unroute('**/api/jobs/resume-truth');
    await page.getByRole('button', { name: 'Retry save' }).click();
    await expect(page.getByRole('status')).toContainText('1 truth approved');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath('local-truth-review-200-percent.png'),
      fullPage: true,
    });
    await page.getByRole('link', { name: 'Leads', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Leads', exact: true })).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Posting URL' })
      .fill('https://example.test/jobs/browser-fixture');
    await page.getByRole('textbox', { name: 'Role title' }).fill('Local browser fixture');
    await page
      .getByRole('textbox', { name: 'Organization', exact: true })
      .fill('Fixture organization');
    await page.getByRole('button', { name: 'Save lead', exact: true }).click();
    await expect(
      page.getByRole('link', { name: 'Local browser fixture', exact: true }),
    ).toBeVisible();
    await page.getByRole('combobox', { name: 'Decision', exact: true }).selectOption('keep');
    await page.getByRole('button', { name: 'Save lead review', exact: true }).click();
    await page
      .getByRole('checkbox', { name: 'Local browser fixture · Fixture organization' })
      .check();
    await page.getByRole('button', { name: 'Queue selected leads' }).click();
    await page.getByRole('link', { name: 'Today', exact: true }).click();
    await expect(page.getByText('Fixture organization · queued')).toBeVisible();
  } finally {
    await page.close();
    if (processHandle.exitCode === null)
      await new Promise<void>((resolve) => {
        processHandle.once('exit', () => resolve());
        processHandle.kill('SIGTERM');
      });
    await rm(root, { recursive: true, force: true });
  }
});
