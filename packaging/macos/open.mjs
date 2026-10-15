#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const node = path.join(app, 'node');
const cwd = path.join(app, 'app');
const installation = JSON.parse(await readFile(path.join(app, 'installation.json'), 'utf8'));
const env = { ...process.env, JOBDESK_DATA_DIR: installation.data };
function cli(command) {
  return spawnSync(node, ['--import', 'tsx', 'services/jobdesk/cli.ts', command], { cwd, env, stdio: 'inherit' });
}
if (cli('status').status !== 0) {
  const launch = spawnSync('/bin/launchctl', ['kickstart', 'gui/' + process.getuid() + '/' + installation.label], { stdio: 'inherit' });
  if (launch.status !== 0) process.exit(1);
  let ok = false;
  for (let i = 0; i < 15; i++) {
    if (spawnSync(node, ['--import', 'tsx', 'services/jobdesk/cli.ts', 'status'], { cwd, env, stdio: 'ignore' }).status === 0) { ok = true; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!ok) { console.error('Jobdesk is unavailable. Inspect private owner.log; do not erase owner.lock.'); process.exit(1); }
}
process.exitCode = cli('open').status ?? 1;
