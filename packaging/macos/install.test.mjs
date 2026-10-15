import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergeClaude, agentPlist, install, waitForReady } from './install.mjs';

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
  assert.match(agentPlist('/tmp/a&<b>', { home: '/fictional' }), /a&amp;&lt;b&gt;/);
});
async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'jobdesk-install-'));
  const bundle = path.join(root, 'zip');
  const source = path.join(bundle, 'payload/app/services/jobdesk');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'server.ts'), 'old');
  await writeFile(path.join(bundle, 'payload/node'), 'node');
  const opts = { bundle, app: path.join(root, 'installed'), agent: path.join(root, 'agent.plist'),
    claude: path.join(root, 'claude.json'), home: path.join(root, 'home'), yes: true, ready: async () => {},
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
    const prevAgent = agentPlist(opts.app, { home: opts.home });
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
test('legacy data stays authoritative through first install and repeat install', async () => {
  await fixture(async ({ opts }) => {
    const legacy = path.join(opts.home, 'Library/Application Support/Arcades Jobdesk');
    const primary = path.join(opts.home, 'Library/Application Support/Job Search Harness');
    await mkdir(legacy, { recursive: true, mode: 0o700 });
    await writeFile(path.join(legacy, 'retained-data'), 'keep this exact data');
    for (let i = 0; i < 2; i++) {
      await install(opts);
      const installation = JSON.parse(await readFile(path.join(opts.app, 'installation.json'), 'utf8'));
      assert.equal(installation.data, legacy);
      assert.match(await readFile(opts.agent, 'utf8'), /Arcades Jobdesk/);
      assert.equal(await readFile(path.join(legacy, 'retained-data'), 'utf8'), 'keep this exact data');
      await assert.rejects(access(primary), /ENOENT/);
    }
  });
});
test('an unhealthy launch rolls back before changing Claude settings', async () => {
  await fixture(async ({ opts }) => {
    const original = '{"theme":"dark"}';
    await writeFile(opts.claude, original);
    await assert.rejects(install({ ...opts, ready: async () => { throw new Error('not ready'); } }), /not ready/);
    assert.equal(await readFile(opts.claude, 'utf8'), original);
    await assert.rejects(access(opts.app), /ENOENT/);
    await assert.rejects(access(opts.agent), /ENOENT/);
  });
});
test('concurrent Claude edits are retained and installation rolls back', async () => {
  await fixture(async ({ opts }) => {
    const edit = '{"theme":"new user preference"}';
    await assert.rejects(install({ ...opts, ready: () => writeFile(opts.claude, edit) }), /Configuration changed/);
    assert.equal(await readFile(opts.claude, 'utf8'), edit);
    await assert.rejects(access(opts.app), /ENOENT/);
  });
});
test('refuses unrelated agents and dangling destination symlinks', async () => {
  await fixture(async ({ root, opts }) => {
    await writeFile(opts.agent, '<string>me.thearcades.job-search-harness</string>');
    await assert.rejects(install(opts), /not owned/);
    await rm(opts.agent);
    await symlink(path.join(root, 'missing'), opts.app);
    await assert.rejects(install(opts), /symlink/);
  });
});
test('launcher uses its own folder without interpolating special shell characters', async () => {
  await fixture(async ({ root, opts }) => {
    const app = path.join(root, 'space $dollar `backtick` "quote"');
    const result = await install({ ...opts, app });
    const script = await readFile(result.launcher, 'utf8');
    assert.match(script, /cd "\$\(dirname "\$0"\)"/);
    assert.equal(script.includes(app), false);
    assert.equal(spawnSync('/bin/bash', ['-n', result.launcher]).status, 0);
  });
});
test('LaunchAgent acceptance requires a matching owner PID, not bootstrap success', async () => {
  await fixture(async ({ root }) => {
    await assert.rejects(waitForReady({ data: root, label: 'test', timeout: 1,
      ctl: () => ({ status: 0, stdout: 'pid = 123' }) }), /did not become ready/);
  });
});
test('refuses public data directories and logs without changing their permissions', async () => {
  await fixture(async ({ root, opts }) => {
    const data = path.join(root, 'private-data');
    await mkdir(data, { mode: 0o755 });
    await chmod(data, 0o755);
    await assert.rejects(install({ ...opts, data }), /data directory must be private/);
    await chmod(data, 0o700);
    await writeFile(path.join(data, 'owner.log'), 'retain log bytes', { mode: 0o644 });
    await chmod(path.join(data, 'owner.log'), 0o644);
    await assert.rejects(install({ ...opts, data }), /owner.log must be private/);
    assert.equal(await readFile(path.join(data, 'owner.log'), 'utf8'), 'retain log bytes');
  });
});
