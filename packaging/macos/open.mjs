#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const node = path.join(app, 'node');
const cwd = path.join(app, 'app');
function cli(command) {
  return spawnSync(node, ['--import', 'tsx', 'services/jobdesk/cli.ts', command], { cwd, stdio: 'inherit' });
}
if (cli('status').status !== 0) {
  spawnSync('/bin/launchctl', ['kickstart', 'gui/' + process.getuid() + '/me.thearcades.job-search-harness'], { stdio: 'inherit' });
  let ok = false;
  for (let i = 0; i < 15; i++) {
    if (spawnSync(node, ['--import', 'tsx', 'services/jobdesk/cli.ts', 'status'], { cwd, stdio: 'ignore' }).status === 0) { ok = true; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!ok) { console.error('Jobdesk is unavailable. Inspect private owner.log; do not erase owner.lock.'); process.exit(1); }
}
process.exitCode = cli('open').status || 0;
