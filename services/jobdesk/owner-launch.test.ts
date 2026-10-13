import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brokerCall } from './client';

test('detached owner survives launcher exit, duplicate start reuses owner, verified stop cleans lock', async () => {
  const root = await mkdtemp('/tmp/jobdesk-detached-');
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  const env = { ...process.env, JOBDESK_DATA_DIR: root, JOBDESK_PORT: '0' };
  const run = promisify(execFile);
  const invoke = async (command: string) => JSON.parse((await run(process.execPath,
    ['--import', 'tsx', cli, command], { cwd, env, timeout: 30_000 })).stdout.trim());
  let started = false;
  try {
    const first = await invoke('start-background'); started = true;
    assert.equal(first.status, 'started');
    // execFile resolved: the launcher exited, but its detached owner is serving.
    assert.equal((await brokerCall('health', [], path.join(root, 'broker.sock'))).ok, true);
    const before = await readFile(path.join(root, 'owner.lock'), 'utf8');
    const second = await invoke('start-background');
    assert.equal(second.status, 'already_running');
    assert.equal(second.pid, first.pid);
    assert.equal(await readFile(path.join(root, 'owner.lock'), 'utf8'), before);
    assert.equal((await stat(path.join(root, 'owner.log'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(root, 'owner-process.json'))).mode & 0o777, 0o600);
    assert.equal((await invoke('stop-background')).status, 'stopped'); started = false;
    await assert.rejects(readFile(path.join(root, 'owner.lock')), { code: 'ENOENT' });
    assert.equal((await invoke('stop-background')).status, 'stopped');
  } finally {
    if (started) await invoke('stop-background');
    await rm(root, { recursive: true, force: true });
  }
});


test('owner survives executor process-group termination; wrong stop binding is rejected', async () => {
  const root = await mkdtemp('/tmp/jobdesk-executor-');
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  const env = { ...process.env, JOBDESK_DATA_DIR: root, JOBDESK_PORT: '0' };
  const run = promisify(execFile);
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e',
    `import {execFileSync} from 'node:child_process';
     process.stdout.write(execFileSync(process.execPath,
       ['--import','tsx',${JSON.stringify(cli)},'start-background'],{env:process.env,cwd:process.cwd()}));
     setInterval(()=>{},1000);`], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let started = false;
  let wrapperStopped = false;
  try {
    const first = await new Promise<{ pid: number }>((resolve, reject) => {
      let text = '';
      const timeout = setTimeout(() => reject(new Error('Executor fixture timed out.')), 30_000);
      wrapper.stdout!.on('data', (chunk) => {
        text += chunk.toString();
        if (text.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(text.trim())); }
      });
      wrapper.once('error', (error) => { clearTimeout(timeout); reject(error); });
    });
    started = true;
    const exited = once(wrapper, 'exit');
    process.kill(-wrapper.pid!, 'SIGTERM');
    await exited; wrapperStopped = true;
    process.kill(first.pid, 0);
    assert.equal((await brokerCall('health', [], path.join(root, 'broker.sock'))).ok, true);
    const recordPath = path.join(root, 'owner-process.json');
    const record = await readFile(recordPath, 'utf8');
    await writeFile(recordPath, JSON.stringify({ pid: first.pid, hash: 'wrong-binding' }));
    await assert.rejects(run(process.execPath, ['--import','tsx',cli,'stop-background'],
      { cwd, env, timeout: 30_000 }), /Owner changed/);
    assert.equal((await brokerCall('health', [], path.join(root, 'broker.sock'))).ok, true);
    await writeFile(recordPath, record);
    await run(process.execPath, ['--import','tsx',cli,'stop-background'], { cwd, env, timeout: 30_000 });
    started = false;
  } finally {
    if (!wrapperStopped) process.kill(-wrapper.pid!, 'SIGTERM');
    if (started) await run(process.execPath, ['--import','tsx',cli,'stop-background'],
      { cwd, env, timeout: 30_000 });
    await rm(root, { recursive: true, force: true });
  }
});
