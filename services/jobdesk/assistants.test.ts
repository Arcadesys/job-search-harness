import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, rm, writeFile, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { assistantStatus, codexEntry, connectAssistant, repairConnections, SERVER_NAME, withoutCodexEntry } from './assistants';
import { tempRoot, posixModes } from '../../tests/fixtures/temp-root';

const launch = { command: '/Applications/Job Search Harness.app/Contents/MacOS/Job Search Harness', args: ['/data/mcp/1.0.0/mcp-server.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } };

test('Claude Desktop: merges only our entry, backs up, keeps permissions, and repairs a moved app', async () => {
  const home = await tempRoot('assistants-');
  try {
    const where = { platform: 'darwin' as const, home, env: {} };
    const dir = path.join(home, 'Library', 'Application Support', 'Claude'), file = path.join(dir, 'claude_desktop_config.json');
    let [claude] = await assistantStatus(where, launch);
    assert.deepEqual([claude.detected, claude.connected], [false, false]);
    await mkdir(dir, { recursive: true });
    const original = JSON.stringify({ mcpServers: { other: { command: 'other' } }, globalShortcut: 'Ctrl+Space' });
    await writeFile(file, original, { mode: 0o640 });
    await connectAssistant('claude', where, launch);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved.mcpServers.other, { command: 'other' });
    assert.equal(saved.globalShortcut, 'Ctrl+Space');
    assert.deepEqual(saved.mcpServers[SERVER_NAME], launch);
    assert.equal(await readFile(`${file}.before-job-search-harness`, 'utf8'), original);
    if (posixModes) assert.equal((await stat(file)).mode & 0o777, 0o640);
    [claude] = await assistantStatus(where, launch);
    assert.deepEqual([claude.detected, claude.connected, claude.current], [true, true, true]);
    const moved = { ...launch, command: '/Users/me/Downloads/Job Search Harness.app/Contents/MacOS/Job Search Harness' };
    assert.deepEqual(await repairConnections(where, moved), ['claude']);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).mcpServers[SERVER_NAME].command, moved.command);
    assert.deepEqual(await repairConnections(where, moved), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Claude Desktop: an unreadable settings file is reported and never overwritten', async () => {
  const home = await tempRoot('assistants-bad-');
  try {
    const where = { platform: 'linux' as const, home, env: {} };
    const file = path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ "mcpServers": ');
    await assert.rejects(connectAssistant('claude', where, launch), /not valid JSON/);
    assert.equal(await readFile(file, 'utf8'), '{ "mcpServers": ');
    assert.match((await assistantStatus(where, launch))[0].error, /not valid JSON/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Codex: replaces our table and its sub-tables, leaving the rest of config.toml intact', async () => {
  const home = await tempRoot('assistants-codex-');
  try {
    const where = { platform: process.platform, home, env: {} };
    const file = path.join(home, '.codex', 'config.toml');
    await mkdir(path.dirname(file), { recursive: true });
    const windows = { command: 'C:\\Users\\Me\\AppData\\Local\\Programs\\job-search-harness\\Job Search Harness.exe', args: ['C:\\data\\mcp-server.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } };
    await writeFile(file, 'model = "o4"\n\n[mcp_servers.job-search-harness]\ncommand = "node"\nargs = ["/Users/me/job-search-harness/services/jobdesk/mcp-server.mjs"]\n\n[mcp_servers.job-search-harness.env]\nX = "1"\n\n[mcp_servers.other]\ncommand = "other"\n');
    await connectAssistant('codex', where, windows);
    const toml = await readFile(file, 'utf8');
    assert.match(toml, /^model = "o4"/);
    assert.match(toml, /\[mcp_servers\.other\]\ncommand = "other"/);
    assert.doesNotMatch(toml, /\/Users\/me\/job-search-harness|X = "1"/);
    assert.deepEqual(codexEntry(toml), windows);
    assert.equal(withoutCodexEntry(toml).includes(SERVER_NAME), false);
    assert.equal((await assistantStatus(where, windows))[1].current, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an unfamiliar job-search-harness entry is kept until the person chooses Replace; the old macOS installer entry is repaired', async () => {
  const home = await tempRoot('assistants-foreign-');
  try {
    const where = { platform: 'linux' as const, home, env: {} };
    const file = path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
    await mkdir(path.dirname(file), { recursive: true });
    const foreign = { command: 'uvx', args: ['someone-elses-server'] };
    await writeFile(file, JSON.stringify({ mcpServers: { [SERVER_NAME]: foreign } }));
    assert.equal((await assistantStatus(where, launch))[0].foreign, true);
    await assert.rejects(connectAssistant('claude', where, launch), /different job-search-harness connection/);
    assert.deepEqual(await repairConnections(where, launch), []);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).mcpServers[SERVER_NAME], foreign);
    await connectAssistant('claude', where, launch, { replace: true });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).mcpServers[SERVER_NAME], launch);

    const installer = { command: `${home}/Library/Application Support/Job Search Harness App/node`, args: [`${home}/Library/Application Support/Job Search Harness App/app/services/jobdesk/mcp-server.mjs`] };
    await writeFile(file, JSON.stringify({ mcpServers: { [SERVER_NAME]: installer } }));
    assert.equal((await assistantStatus(where, launch))[0].foreign, false);
    assert.deepEqual(await repairConnections(where, launch), ['claude']);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).mcpServers[SERVER_NAME], launch);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('settings that are links or have an unexpected shape are left alone', async () => {
  const home = await tempRoot('assistants-shape-');
  try {
    const where = { platform: 'linux' as const, home, env: {} };
    const file = path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ mcpServers: [] }));
    await assert.rejects(connectAssistant('claude', where, launch), /unexpected mcpServers/);
    await writeFile(file, '[]');
    await assert.rejects(connectAssistant('claude', where, launch), /not a JSON object/);
    if (posixModes) {
      const real = path.join(home, 'dotfiles.json');
      await writeFile(real, '{}');
      await rm(file);
      await symlink(real, file);
      await assert.rejects(connectAssistant('claude', where, launch), /link to another file/);
      assert.equal(await readFile(real, 'utf8'), '{}');
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
