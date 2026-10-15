// A healthy older owner must be left running, with no authenticated URL issued.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { brokerEndpoint } from '../services/jobdesk/paths.mjs';
const root = await mkdtemp('/tmp/jh-old-');
await chmod(root, 0o700);
const lock = JSON.stringify({ pid: process.pid });
await writeFile(path.join(root, 'owner.lock'), lock, { mode: 0o600 });
const methods = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const { method } = JSON.parse(body);
  methods.push(method);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ data: { ok: true, migrations: [{ version: '0001_initial.sql' }] } }));
});
await new Promise(resolve => server.listen(brokerEndpoint(root), resolve));
try {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const binary = process.argv[2] ?? process.execPath;
  await assert.rejects(promisify(execFile)(binary, ['--import', 'tsx', path.join(repo, 'desktop/launch.ts')], {
    cwd: repo, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', JOBDESK_DATA_DIR: root }, timeout: 10_000,
  }), error => error.code === 1 && error.stderr.includes('different version'));
  assert.ok(methods.length >= 2);
  assert.ok(methods.every(method => method === 'health'));
  assert.equal(await readFile(path.join(root, 'owner.lock'), 'utf8'), lock);
  assert.equal(server.listening, true);
  console.log('PASS: older owner refused; no browser ticket, shutdown or lock change');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
