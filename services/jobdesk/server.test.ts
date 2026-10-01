import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { startJobdesk } from './server';
import { brokerCall } from './client';
import { leadIdForUrl } from '../../lib/job-discovery';

function raw(origin: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const req = request(origin, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    req.end();
  });
}

test('real foreground broker: IPC, local browser session, Host/Origin/CSRF, thin stdio worker and offline failure', async (context) => {
  const started = performance.now();
  const root = await mkdtemp('/tmp/jobdesk-ipc-');
  const runtime = await startJobdesk({ root });
  try {
    const call = (method: any, args: any[] = []) => brokerCall(method, args, runtime.socketPath);
    const health = await call('health');
    assert.equal(health.ok, true);
    context.diagnostic(
      `Foreground startup ${Math.round(performance.now() - started)} ms; process RSS ${health.memoryMb} MiB (test process, not an idle production benchmark).`,
    );
    assert.equal((await stat(runtime.socketPath)).mode & 0o777, 0o600);
    assert.equal((await fetch(`${runtime.origin}/api/jobs/resume-truth`)).status, 401);
    assert.equal(await raw(runtime.origin, { Host: 'evil.test' }), 403);
    assert.equal(
      (await fetch(`${runtime.origin}/`, { headers: { Origin: 'https://evil.test' } })).status,
      403,
    );
    assert.equal(
      (await fetch(`${runtime.origin}/`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status,
      403,
    );
    const launch = await call('browser.open');
    const ticket = new URL(launch.url).hash.slice('#ticket='.length);
    const login = await fetch(`${runtime.origin}/session`, {
      method: 'POST',
      headers: { Origin: runtime.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    assert.equal(login.status, 200);
    const { csrf } = await login.json();
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.equal(
      (
        await fetch(`${runtime.origin}/session`, {
          method: 'POST',
          headers: { Origin: runtime.origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket }),
        })
      ).status,
      401,
    );
    const initial = await fetch(`${runtime.origin}/api/jobs/resume-truth`, {
      headers: { Cookie: cookie },
    });
    assert.equal(initial.headers.get('cache-control'), 'private, no-store');
    const { claims } = await initial.json();
    assert.ok(claims.every((c: any) => c.reviewStatus === 'unreviewed'));
    const mutation = JSON.stringify({
      changes: [{ id: claims[0].id, expectedVersion: claims[0].version, reviewStatus: 'reviewed' }],
    });
    assert.equal(
      (
        await fetch(`${runtime.origin}/api/jobs/resume-truth`, {
          method: 'POST',
          headers: { Cookie: cookie, Origin: runtime.origin, 'Content-Type': 'application/json' },
          body: mutation,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${runtime.origin}/api/jobs/resume-truth`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: 'https://evil.test',
            'Content-Type': 'application/json',
            'X-Jobdesk-CSRF': csrf,
          },
          body: mutation,
        })
      ).status,
      403,
    );
    const saved = await fetch(`${runtime.origin}/api/jobs/resume-truth`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: runtime.origin,
        'Content-Type': 'application/json',
        'X-Jobdesk-CSRF': csrf,
      },
      body: mutation,
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).progress.reviewed, 1);
    await assert.rejects(call('sql' as any, ['SELECT * FROM job_leads']));
    await assert.rejects(runtime.service({ method: 'sql', args: ['SELECT * FROM job_leads'] }));
    await assert.rejects(call('leads.list', ['unexpected']));
    const url = 'https://example.test/jobs/stdio-fixture';
    await call('leads.add', [{ url, title: 'Stdio test fixture' }]);
    const id = leadIdForUrl(url);
    await call('leads.update', [{ id, decision: 'keep' }]);
    const batch = await call('batches.create', [[id]]);
    const { items } = await call('batches.items', [batch.id]);
    const itemId = items[0].itemId;
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'job_hunt_list_batches', arguments: {} },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'job_hunt_update_item_status', arguments: { itemId, status: 'preparing' } },
      },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'job_hunt_renew_lease', arguments: { itemId } },
      },
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'job_hunt_update_item_status',
          arguments: {
            itemId,
            status: 'blocked',
            note: 'Synthetic worker blocker; no employer opened.',
          },
        },
      },
    ];
    const replies = await new Promise<any[]>((resolve, reject) => {
      const worker = spawn(process.execPath, ['services/jobdesk/mcp-server.mjs'], {
        cwd: process.cwd(),
        env: { ...process.env, JOBDESK_SOCKET: runtime.socketPath },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      worker.stdout.on('data', (chunk) => (stdout += chunk));
      worker.stderr.on('data', (chunk) => (stderr += chunk));
      worker.on('error', reject);
      worker.on('close', (code) => {
        try {
          assert.equal(code, 0);
          assert.equal(stderr, '');
          resolve(
            stdout
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line)),
          );
        } catch (error) {
          reject(error);
        }
      });
      worker.stdin.end(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
    });
    assert.equal(replies.length, 6);
    assert.ok(replies.every((r) => r.jsonrpc === '2.0'));
    for (const name of [
      'job_hunt_list_batches',
      'job_hunt_list_batch_items',
      'job_hunt_get_item',
      'job_hunt_update_item_status',
      'job_hunt_record_submission',
    ])
      assert.ok(replies[1].result.tools.some((tool: any) => tool.name === name));
    assert.ok(replies.slice(2).every((r) => !r.result.isError));
    assert.equal((await call('items.read', [itemId])).item.status, 'blocked');
    const logout = await fetch(`${runtime.origin}/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: runtime.origin, 'X-Jobdesk-CSRF': csrf },
    });
    assert.equal(logout.status, 200);
    assert.equal(
      (await fetch(`${runtime.origin}/api/jobs/resume-truth`, { headers: { Cookie: cookie } }))
        .status,
      401,
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
  await assert.rejects(brokerCall('health', [], runtime.socketPath), /unavailable/);
});
