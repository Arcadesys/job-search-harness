import { test, expect, _electron as electron } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import electronPath from 'electron';
import { tempRoot } from '../fixtures/temp-root';
import { brokerCall } from '../../services/jobdesk/client';
import { brokerEndpoint } from '../../services/jobdesk/paths.mjs';
import { assistantPaths } from '../../services/jobdesk/assistant-paths';

// JOBDESK_DESKTOP_EXECUTABLE tests a packaged build; otherwise Electron runs the staged folder.
const packaged = process.env.JOBDESK_DESKTOP_EXECUTABLE;
const APP = path.resolve('dist/app');
const root = process.getuid?.() === 0 ? ['--no-sandbox'] : [];

/** Point every per-user folder lookup at the temporary home, on any platform. */
const homeEnv = (home: string) => ({ HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(home, '.config') });

/** Speak MCP over stdio exactly as an assistant would, using the command the app wrote. */
async function callTool(launch: { command: string; args: string[]; env?: Record<string, string> }, home: string, tool: string) {
  const child = spawn(launch.command, launch.args, { env: { ...process.env, ...homeEnv(home), ...launch.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies: any[] = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) { replies.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: {} } })}\n`);
  const deadline = Date.now() + 60_000;
  while (!replies.some((reply) => reply.id === 2) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  child.kill();
  return replies.find((reply) => reply.id === 2);
}

test('first run: connect Claude Desktop, preferences, résumé upload, live MCP and auto-launch', async ({ browserName: _browser }, info) => {
  test.setTimeout(180_000);
  const home = await tempRoot('desktop-home-');
  const data = path.join(home, 'data');
  await mkdir(data, { mode: 0o700 });
  const claude = assistantPaths({ home, env: homeEnv(home) }).claude;
  await mkdir(claude.dir, { recursive: true });
  await writeFile(claude.file,
    JSON.stringify({ mcpServers: { other: { command: 'other-tool', args: [] } }, theme: 'dark' }));
  const env = { ...process.env, ...homeEnv(home), JOBDESK_DATA_DIR: data, JOBDESK_SMOKE: '1' } as Record<string, string>;
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([612, 792]);
  ['Alex Example', 'Data Analyst', '• Built weekly dashboards for twelve teams.', '• Cut report preparation time by half.']
    .forEach((line, index) => page.drawText(line, { x: 48, y: 740 - index * 24, size: 13, font }));
  const resumeFile = path.join(home, 'resume.pdf');
  await writeFile(resumeFile, await pdf.save());

  const app = await electron.launch({ executablePath: packaged ?? electronPath as unknown as string, args: packaged ? root : [APP, ...root], env });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on('pageerror', (error) => errors.push(error.message));
    await expect(window).toHaveTitle('Job Search Harness');
    await expect(window.getByRole('heading', { name: 'Welcome to Job Search Harness' })).toBeVisible();
    expect((await new AxeBuilder({ page: window }).setLegacyMode(true).analyze()).violations).toEqual([]);

    await window.getByRole('button', { name: 'Connect Claude Desktop' }).click();
    await expect(window.getByRole('status')).toContainText('Claude Desktop is connected');
    const config = JSON.parse(await readFile(claude.file, 'utf8'));
    expect(config.theme).toBe('dark');
    expect(config.mcpServers.other.command).toBe('other-tool');
    const launch = config.mcpServers['job-search-harness'];
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1');
    const setup = await callTool(launch, home, 'job_hunt_setup_status');
    expect(setup.result.structuredContent.data.truths.total).toBe(0);
    // At the default 125% zoom a 1440-pixel window is too narrow to dock the panel.
    const showActivity = window.getByRole('button', { name: 'Show activity' });
    if (await showActivity.isVisible()) await showActivity.click();
    await expect(window.getByRole('list', { name: 'Recent tool calls' })).toContainText('job_hunt_setup_status', { timeout: 15_000 });
    await window.getByRole('button', { name: 'Close activity' }).click();

    await window.getByRole('button', { name: 'Continue' }).click();
    await window.getByRole('textbox', { name: 'Role or field' }).fill('Data analyst');
    await window.getByRole('textbox', { name: 'Location' }).fill('Remote');
    await window.getByRole('button', { name: 'Save and continue' }).click();
    await expect(window.getByRole('heading', { name: 'Add your current résumé' })).toBeVisible();
    await window.getByLabel(/Choose a résumé file/).setInputFiles(resumeFile);
    await expect(window.getByRole('status')).toContainText('Check them below');
    await expect(window.getByRole('textbox', { name: /Résumé text/ })).toHaveValue(/Built weekly dashboards for twelve teams\./);
    await window.getByRole('button', { name: /claims to review/ }).click();
    await expect(window.getByRole('heading', { name: 'You’re set up' })).toBeVisible();
    await window.screenshot({ path: info.outputPath('first-run-done.png') });
    await window.getByRole('link', { name: 'Review my claims' }).click();
    await expect(window.getByText('Built weekly dashboards for twelve teams.')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }

  // With the app closed, the assistant's MCP adapter starts it in the background on demand.
  const config = JSON.parse(await readFile(claude.file, 'utf8'));
  const launch = config.mcpServers['job-search-harness'];
  const status = await callTool({ ...launch, env: { ...launch.env, JOBDESK_SMOKE: '1' } }, home, 'job_hunt_setup_status');
  expect(status.result.structuredContent.data.truths.total).toBe(4);
  expect(status.result.structuredContent.data.searches.total).toBe(1);
  await brokerCall('owner.shutdown', [], brokerEndpoint(data));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await rm(home, { recursive: true, force: true });
});
