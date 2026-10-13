import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { startJobdesk } from './server';
import { brokerCall } from './client';
import { systemTimeZone } from '../../lib/jobdesk-settings';
import { sampleResume } from '../../tests/fixtures/sample-resume';
import { posixModes, tempRoot } from '../../tests/fixtures/temp-root';
import { apiKeyFor } from './secrets';

/** Runs the real stdio adapter once and returns each tool result. */
function mcp(socket: string, calls: Array<{ name: string; arguments: unknown }>) {
  const messages = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    ...calls.map((params, index) => ({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params })),
  ];
  return new Promise<Array<{ isError?: boolean; data: any; text: string }>>((resolve, reject) => {
    const worker = spawn(process.execPath, ['services/jobdesk/mcp-server.mjs'], {
      cwd: process.cwd(), env: { ...process.env, JOBDESK_SOCKET: socket }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    worker.stdout.on('data', (chunk) => (stdout += chunk));
    worker.on('error', reject);
    worker.on('close', () => {
      const replies = stdout.trim().split('\n').map((line) => JSON.parse(line)).filter((reply) => reply.id > 0)
        .sort((a, b) => a.id - b.id);
      resolve(replies.map(({ result }) => {
        const text = result.content[0].text;
        let data: unknown;
        try { data = JSON.parse(text); } catch { data = undefined; }
        return { isError: result.isError, data, text };
      }));
    });
    for (const message of messages) worker.stdin.write(`${JSON.stringify(message)}\n`);
    worker.stdin.end();
  });
}

test('a fresh install starts empty and an AI client can import the user’s own résumé', async () => {
  const root = await tempRoot('jobdesk-onboarding-');
  const runtime = await startJobdesk({ root });
  try {
    const call = (method: any, args: any[] = []) => brokerCall(method, args, runtime.socketPath);
    assert.deepEqual(await call('truth.list'), [], 'nobody else’s résumé is seeded');
    assert.deepEqual((await call('search.settings')).queries, [], 'no searches are preset');
    assert.equal((await call('settings.read')).timeZone, systemTimeZone());

    const [before, imported, again, added, after] = await mcp(runtime.socketPath, [
      { name: 'job_hunt_setup_status', arguments: {} },
      { name: 'job_hunt_import_resume', arguments: sampleResume },
      { name: 'job_hunt_import_resume', arguments: sampleResume },
      {
        name: 'job_hunt_add_resume_text',
        arguments: {
          text: '• Mentored four new scrum masters\n- Speaks conversational Spanish\n\n  Speaks conversational Spanish  \nok',
          sourceNote: 'Typed by the user during setup.',
        },
      },
      { name: 'job_hunt_setup_status', arguments: {} },
    ]);
    assert.equal(before.data.truths.total, 0);
    assert.match(before.data.nextStep, /job_hunt_import_resume/);
    assert.equal(imported.data.imported, 51);
    assert.equal(again.isError, true);
    assert.match(again.text, /already has claims/);
    assert.deepEqual(added.data, { imported: 1, skipped: 1 }, 'existing and repeated lines are skipped; short ones ignored');
    assert.deepEqual(after.data.truths, { total: 52, reviewed: 0, unreviewed: 52 });
    assert.match(after.data.nextStep, /review their truths/);

    const claims = await call('truth.list');
    assert.ok(claims.every((claim: any) => claim.reviewStatus === 'unreviewed'));
    assert.equal(claims.find((claim: any) => claim.id === 'other.1').claim, 'Speaks conversational Spanish');
    assert.equal(claims.find((claim: any) => claim.id === 'experience.3.employer').claim, 'Northwind Logistics — Denver, CO');
    assert.equal((await call('truth.versions', ['other.1'])).length, 1, 'each import records its first version');
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('settings and searches belong to the user and are validated', async () => {
  const root = await tempRoot('jobdesk-settings-');
  const runtime = await startJobdesk({ root });
  try {
    const call = (method: any, args: any[] = []) => brokerCall(method, args, runtime.socketPath);
    await call('settings.save', [{ timeZone: 'Europe/Berlin', drafting: { provider: 'none', model: '' } }]);
    assert.equal((await call('settings.read')).timeZone, 'Europe/Berlin');
    await assert.rejects(call('settings.save', [{ timeZone: 'Mars/Olympus', drafting: { provider: 'none', model: '' } }]));
    assert.equal((await call('settings.read')).timeZone, 'Europe/Berlin', 'a rejected save changes nothing');

    const feedUrl = 'https://www.google.com/alerts/feeds/11/22';
    await call('search.save', [[
      { lane: 'Nurse educator', location: 'Portland, OR', query: 'nurse educator jobs Portland', feedUrl, enabled: true },
      { lane: 'Nurse educator', location: 'Remote', query: 'remote nurse educator jobs', feedUrl: '', enabled: false },
    ]]);
    const saved = (await call('search.settings')).queries;
    assert.deepEqual(saved.map((query: any) => query.id).sort(), ['nurse-educator-portland-or', 'nurse-educator-remote']);
    const kept = saved.find((query: any) => query.id === 'nurse-educator-remote');
    await call('search.save', [[{ ...kept, query: 'remote clinical educator jobs', feedUrl: '' }]]);
    const edited = (await call('search.settings')).queries;
    assert.deepEqual(edited.map((query: any) => [query.id, query.query]), [['nurse-educator-remote', 'remote clinical educator jobs']],
      'saving replaces the list and keeps existing IDs');
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('API keys are write-only, user-only, and never enter the database or its backups', async () => {
  const root = await tempRoot('jobdesk-keys-');
  const runtime = await startJobdesk({ root });
  const key = 'sk-ant-synthetic-test-key-never-sent';
  try {
    const call = (method: any, args: any[] = []) => brokerCall(method, args, runtime.socketPath);
    const initial = await call('settings.read');
    if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY)
      assert.deepEqual(initial.drafting, { provider: 'none', model: '' }, 'drafting in the cockpit is off until chosen');
    await call('settings.save', [{ timeZone: initial.timeZone, drafting: { provider: 'anthropic', model: '' } }]);
    await call('settings.saveApiKey', ['anthropic', key]);
    const read = await call('settings.read');
    assert.equal(read.apiKeys.anthropic, true);
    assert.ok(!JSON.stringify(read).includes(key), 'settings report that a key exists, never its value');
    if (posixModes) assert.equal((await stat(path.join(root, 'secrets.json'))).mode & 0o777, 0o600);
    const backup = await call('backup');
    for (const file of await readdir(backup.directory))
      if (!file.endsWith('.gz') && file !== 'artifacts')
        assert.ok(!(await readFile(path.join(backup.directory, file), 'utf8')).includes(key), `${file} holds no key`);
    assert.equal(await apiKeyFor(root, 'anthropic', { ANTHROPIC_API_KEY: 'from-environment' }), 'from-environment',
      'an installer-provided environment key wins');
    await assert.rejects(call('settings.saveApiKey', ['openai', 'two words']), /does not look like an API key/);
    await call('settings.saveApiKey', ['anthropic', '']);
    assert.equal(await apiKeyFor(root, 'anthropic', {}), undefined, 'an empty key clears it');
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
