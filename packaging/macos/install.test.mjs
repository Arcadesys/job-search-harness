import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergeClaude, agentPlist, install } from './install.mjs';

test('preserves unrelated Claude preferences and MCP servers', () => {
  const old = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other' } } });
  const result = JSON.parse(mergeClaude(old, '/safe/node', '/safe/mcp.mjs'));
  assert.equal(result.theme, 'dark');
  assert.deepEqual(result.mcpServers.other, { command: 'other' });
  assert.deepEqual(result.mcpServers['job-search-harness'], { command: '/safe/node', args: ['/safe/mcp.mjs'] });
  assert.deepEqual(JSON.parse(mergeClaude(JSON.stringify(result), '/safe/node', '/safe/mcp.mjs')), result);
});
test('refuses collisions and corrupted configuration', () => {
  assert.throws(() => mergeClaude('oops', '/node', '/mcp'), SyntaxError);
  assert.throws(() => mergeClaude('{"mcpServers":[]}', '/node', '/mcp'), /mcpServers/);
  assert.throws(() => mergeClaude('{"mcpServers":{"job-search-harness":{"command":"custom"}}}', '/node', '/mcp'), /different/);
});
test('escapes XML plist paths', () => {
  assert.match(agentPlist('/tmp/a&<b>'), /a&amp;&lt;b&gt;/);
});
async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'jobdesk-install-'));
  const bundle = path.join(root, 'zip');
  const source = path.join(bundle, 'payload/app/services/jobdesk');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'server.ts'), 'old');
  await writeFile(path.join(bundle, 'payload/node'), 'node');
  const opts = { bundle, app: path.join(root, 'installed'), agent: path.join(root, 'agent.plist'),
    claude: path.join(root, 'claude.json'), yes: true,
    command: () => {}, ctl: () => ({ status: 0, stderr: '' }) };
  try { await fn({ root, source, opts }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test('installs and repeated install retains Claude settings', async () => {
  await fixture(async ({ opts }) => {
    await writeFile(opts.claude, JSON.stringify({ mcpServers: { existing: { command: 'true' } } }));
    assert.equal((await install(opts)).installed, true);
    const one = await readFile(opts.claude, 'utf8');
    assert.equal((await install(opts)).installed, true);
    assert.equal(await readFile(opts.claude, 'utf8'), one);
    assert.equal(JSON.parse(one).mcpServers.existing.command, 'true');
  });
});
test('failed bootstrap restores previous app, agent and Claude settings', async () => {
  await fixture(async ({ opts }) => {
    await mkdir(opts.app);
    await writeFile(path.join(opts.app, 'marker'), 'retain');
    const prevAgent = agentPlist(opts.app);
    await writeFile(opts.agent, prevAgent);
    const prevClaude = '{"theme":"light"}';
    await writeFile(opts.claude, prevClaude);
    const fail = { ...opts, ctl: (args) => args[0] === 'bootstrap'
      ? { status: 1, stderr: 'simulated launch failure' } : { status: 0, stderr: '' } };
    await assert.rejects(install(fail), /Could not load LaunchAgent/);
    assert.equal(await readFile(path.join(opts.app, 'marker'), 'utf8'), 'retain');
    assert.equal(await readFile(opts.agent, 'utf8'), prevAgent);
    assert.equal(await readFile(opts.claude, 'utf8'), prevClaude);
  });
});
test('declined Claude access makes no installation changes', async () => {
  await fixture(async ({ opts }) => {
    await assert.rejects(install({ ...opts, yes: false,
      approve: async (message) => !message.startsWith('Add job-search') }), /declined/);
    await assert.rejects(readFile(opts.agent, 'utf8'), /ENOENT/);
  });
});
