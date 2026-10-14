#!/usr/bin/env node
// Installer shipped inside the macOS ZIP. No npm, shell profile or admin privileges required.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, cp, lstat, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LABEL = 'me.thearcades.job-search-harness';
const HOME = homedir();
const APP = path.join(HOME, 'Library', 'Application Support', 'Job Search Harness App');
const AGENT = path.join(HOME, 'Library', 'LaunchAgents', LABEL + '.plist');
const CLAUDE = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

export function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
export function agentPlist(app = APP) {
  const node = path.join(app, 'node');
  const server = path.join(app, 'app', 'services/jobdesk/server.ts');
  const log = path.join(HOME, 'Library', 'Application Support', 'Job Search Harness', 'owner.log');
  const s = (v) => '<string>' + xml(v) + '</string>';
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict><key>Label</key>' + s(LABEL) +
    '<key>ProgramArguments</key><array>' + [node, '--import', 'tsx', server].map(s).join('') +
    '</array><key>WorkingDirectory</key>' + s(path.join(app, 'app')) +
    '<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>' +
    '<key>ThrottleInterval</key><integer>30</integer>' +
    '<key>StandardOutPath</key>' + s(log) +
    '<key>StandardErrorPath</key>' + s(log) +
    '</dict></plist>\n';
}
export function mergeClaude(text, command, mcpPath) {
  const data = text?.trim() ? JSON.parse(text) : {};
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Claude config must be a JSON object.');
  if (data.mcpServers !== undefined &&
    (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)))
    throw new Error('Claude mcpServers must be an object.');
  const servers = data.mcpServers || {};
  const entry = { command, args: [mcpPath] };
  if (servers['job-search-harness'] && JSON.stringify(servers['job-search-harness']) !== JSON.stringify(entry))
    throw new Error('Claude already has a different job-search-harness connection. Review it manually; no settings were changed.');
  return JSON.stringify({ ...data, mcpServers: { ...servers, 'job-search-harness': entry } }, null, 2) + '\n';
}
export async function atomicConfig(filename, updated) {
  await mkdir(path.dirname(filename), { recursive: true });
  const current = existsSync(filename) ? await readFile(filename, 'utf8') : null;
  if (current === updated) return false;
  const tmp = filename + '.jobdesk-' + process.pid + '.tmp';
  try {
    await writeFile(tmp, updated, { flag: 'wx', mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, filename);
  } finally { await rm(tmp, { force: true }); }
  return true;
}
function run(exe, args) {
  const result = spawnSync(exe, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(exe + ' failed: ' + (result.stderr || result.stdout || result.error?.message || 'unknown'));
}
function launchctl(args) { return spawnSync('/bin/launchctl', args, { encoding: 'utf8' }); }
async function regularOrAbsent(p) {
  if (!existsSync(p)) return;
  const st = await lstat(p);
  if (st.isSymbolicLink()) throw new Error('Refusing symlink at ' + p);
}
async function confirm(question, automatic) {
  if (automatic) return true;
  if (!stdin.isTTY) throw new Error('Interactive confirmation required. Rerun in Terminal or use --yes after reviewing the installer.');
  const rl = createInterface({ input: stdin, output: stdout });
  try { return /^y(es)?$/i.test((await rl.question(question + ' [y/N] ')).trim()); }
  finally { rl.close(); }
}
export async function install({ bundle = path.resolve(HERE, '../../../..'), app = APP, agent = AGENT, claude = CLAUDE, yes = false,
  command = run, ctl = launchctl, approve = confirm } = {}) {
  if (process.platform !== 'darwin' && !process.env.JOBDESK_INSTALL_TEST)
    throw new Error('This installer is for macOS only.');
  const node = path.join(bundle, 'payload', 'node');
  const source = path.join(bundle, 'payload', 'app');
  if (!existsSync(node) || !existsSync(path.join(source, 'services/jobdesk/server.ts')))
    throw new Error('Incomplete installer bundle. Download the entire ZIP, not the standalone installer script.');
  await regularOrAbsent(app); await regularOrAbsent(agent); await regularOrAbsent(claude);
  if (!await approve('Install Job Search Harness for this Mac user? Existing local data will be retained.', yes))
    return { installed: false };
  // Never seize a live owner, and never remove a stale lock automatically.
  const dataDirs = [path.join(HOME, 'Library/Application Support/Job Search Harness'),
    path.join(HOME, 'Library/Application Support/Arcades Jobdesk')];
  // Preflight JSON before any writes. Never drop unrelated MCP settings.
  const original = existsSync(claude) ? await readFile(claude, 'utf8') : null;
  const merged = mergeClaude(original, path.join(app, 'node'),
    path.join(app, 'app/services/jobdesk/mcp-server.mjs'));
  if (original !== merged && !await approve('Add job-search-harness to Claude Desktop MCP settings? (Other settings remain unchanged.)', yes))
    throw new Error('Claude Desktop integration was declined; no installation occurred.');
  const stage = app + '.staging-' + process.pid;
  const previous = app + '.previous-' + process.pid;
  let movedPrevious = false, installedNew = false, agentChanged = false, loaded = false, stoppedOld = false;
  const oldAgent = existsSync(agent) ? await readFile(agent, 'utf8') : null;
  if (oldAgent && !oldAgent.includes('<string>' + LABEL + '</string>'))
    throw new Error('LaunchAgent destination is not owned by Job Search Harness.');
  await mkdir(path.dirname(app), { recursive: true });
  await mkdir(path.dirname(agent), { recursive: true });
  await rm(stage, { recursive: true, force: true });
  try {
    // Detach only the known Jobdesk agent, never a process matched by name.
    // A manually launched owner remains locked and is never taken over.
    const domain = 'gui/' + process.getuid();
    if (oldAgent) {
      const stop = ctl(['bootout', domain, agent]);
      if (stop.status === 0) stoppedOld = true;
      else if (!['Could not find service', 'No such process', 'Input/output error'].some(msg => (stop.stderr || '').includes(msg)))
        throw new Error('Could not stop existing Jobdesk LaunchAgent: ' + stop.stderr);
    }
    for (const dir of dataDirs) {
      const lock = path.join(dir, 'owner.lock');
      if (existsSync(lock)) {
        // Launchd sends SIGTERM; store.close releases the lock after clean shutdown.
        let released = false;
        for (let i = 0; i < 40; i++) {
          if (!existsSync(lock)) { released = true; break; }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!released) throw new Error('Existing Jobdesk owner/lock at ' + dir +
          '. Stop manually launched owners or recover crashed locks explicitly.');
      }
    }
    await mkdir(stage, { mode: 0o700 });
    await cp(source, path.join(stage, 'app'), { recursive: true, errorOnExist: true, force: false });
    await cp(node, path.join(stage, 'node'));
    await chmod(path.join(stage, 'node'), 0o700);
    // Don't replace the currently installed runtime until staged completely.
    if (existsSync(app)) { await rename(app, previous); movedPrevious = true; }
    await rename(stage, app); installedNew = true;
    const launcher = '#!/bin/bash\nset -euo pipefail\ncd ' + JSON.stringify(app) +
      '\n./node ./app/packaging/macos/open.mjs\n';
    await writeFile(path.join(app, 'Open Job Search Harness.command'), launcher, { mode: 0o700 });
    // Running agents must be detached before replacing their definition.
    const domain = 'gui/' + process.getuid();
    const prior = ctl(['bootout', domain, agent]);
    if (prior.status !== 0 && oldAgent && !/Could not find service|No such process|Input\/output error/.test(prior.stderr || ''))
      throw new Error('Could not detach previous LaunchAgent: ' + prior.stderr);
    await atomicConfig(agent, agentPlist(app)); agentChanged = true;
    command('/usr/bin/plutil', ['-lint', agent]);
    // LaunchAgent logs must already have a private parent directory.
    const data = dataDirs.find(d => existsSync(d)) || dataDirs[0];
    await mkdir(data, { recursive: true, mode: 0o700 });
    const log = path.join(dataDirs[0], 'owner.log');
    await mkdir(path.dirname(log), { recursive: true, mode: 0o700 });
    if (!existsSync(log)) await writeFile(log, '', { flag: 'wx', mode: 0o600 });
    const start = ctl(['bootstrap', domain, agent]);
    if (start.status !== 0) throw new Error('Could not load LaunchAgent: ' + start.stderr);
    loaded = true;
    await atomicConfig(claude, merged);
    await rm(previous, { recursive: true, force: true });
    return { installed: true, app, launcher: path.join(app, 'Open Job Search Harness.command'), claudeRestart: true };
  } catch (error) {
    // Roll back executable and launch settings; data and secrets were never touched.
    const domain = 'gui/' + process.getuid?.();
    if (loaded) ctl(['bootout', domain, agent]);
    if (agentChanged) {
      if (oldAgent === null) await rm(agent, { force: true });
      else await atomicConfig(agent, oldAgent);
    }
    if (installedNew) await rm(app, { recursive: true, force: true });
    if (movedPrevious) await rename(previous, app);
    if (stoppedOld) ctl(['bootstrap', domain, agent]);
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install({ yes: process.argv.includes('--yes') }).then(result => {
    if (result.installed) console.log('Installed. Restart Claude Desktop, then double-click Open Job Search Harness.command.');
    else console.log('Installation cancelled.');
  }).catch(e => { console.error('Installation stopped: ' + e.message); process.exitCode = 1; });
}
