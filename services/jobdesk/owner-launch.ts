import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { DEFAULT_ROOT, privateRoot } from './store';
import { brokerEndpoint } from './paths.mjs';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const recordName = 'owner-process.json';

async function owner(root: string) {
  try {
    const text = await readFile(path.join(root, 'owner.lock'), 'utf8');
    const { pid } = JSON.parse(text);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid owner lock.');
    return { pid: pid as number, hash: digest(text) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function ipc(root: string, method: string) {
  return new Promise<boolean>((resolve) => {
    const req = request({ socketPath: brokerEndpoint(root), path: '/rpc',
      method: 'POST', headers: { Host: 'jobdesk', 'Content-Type': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString();
        if (body.length > 100_000) req.destroy();
      });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 && JSON.parse(body).data?.ok === true); }
        catch { resolve(false); }
      });
    });
    req.setTimeout(1500, () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(JSON.stringify({ method, args: [] }));
  });
}
const healthy = (root: string) => ipc(root, 'health');

export async function startDetachedOwner(directory = process.env.JOBDESK_DATA_DIR ?? DEFAULT_ROOT) {
  const root = await privateRoot(directory);
  const existing = await owner(root);
  if (existing) {
    if (!alive(existing.pid))
      throw new Error('Stopped owner lock: use jobs:cli recover-lock, then reconcile submissions.');
    if (!await healthy(root))
      throw new Error('An owner is running but not responding. Do not launch another owner.');
    return { status: 'already_running', pid: existing.pid };
  }

  // A manually launched process session, not a login agent or restart supervisor.
  // The server still acquires the sole database-owner lock before touching data.
  const log = await open(path.join(root, 'owner.log'),
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    const info = await log.stat();
    if (process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o077))
      throw new Error('Owner log must be private and owned by the current user.');
    child = spawn(process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./server.ts', import.meta.url))], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { ...process.env, JOBDESK_DATA_DIR: root },
        detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
      });
  } finally { await log.close(); }
  let failed = false;
  child.on('error', () => { failed = true; });
  child.on('exit', () => { failed = true; });
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !failed) {
    const current = await owner(root);
    if (current && current.pid === child.pid && await healthy(root)) {
      await writeFile(path.join(root, recordName), JSON.stringify(current), { mode: 0o600 });
      return { status: 'started', pid: current.pid, logPath: path.join(root, 'owner.log') };
    }
    // A concurrent launcher can win the same existing store's lock; never adopt it.
    if (current && current.pid !== child.pid)
      throw new Error('Another owner won startup. Read its status; no duplicate database owner started.');
    await pause(200);
  }
  throw new Error('Owner did not become ready. Inspect the private owner.log and reconcile before retrying.');
}

export async function stopDetachedOwner(directory = process.env.JOBDESK_DATA_DIR ?? DEFAULT_ROOT) {
  const root = await privateRoot(directory);
  const current = await owner(root);
  if (!current) return { status: 'stopped' };
  const record = JSON.parse(await readFile(path.join(root, recordName), 'utf8'));
  if (record.pid !== current.pid || record.hash !== current.hash)
    throw new Error('Owner changed or is not this launcher’s owner; do not stop it.');
  if (!alive(current.pid) || !await healthy(root))
    throw new Error('Owner is unavailable. Use documented recovery and reconcile submissions.');
  // Recheck the exact lock immediately before signalling the verified owner.
  if ((await owner(root))?.hash !== current.hash) throw new Error('Owner lock changed.');
  // Ask the owner to close its database and lock itself. A signal would kill a
  // Windows process outright and leave a stale lock behind.
  if (!await ipc(root, 'owner.shutdown')) throw new Error('Owner refused shutdown. Do not recover a live lock.');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!await owner(root)) {
      await rm(path.join(root, recordName));
      return { status: 'stopped' };
    }
    await pause(200);
  }
  throw new Error('Shutdown is not confirmed. Do not recover a live lock or start another owner.');
}
