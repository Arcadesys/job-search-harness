import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import {
  authenticateMcpToken, bearerToken, createApplicationBatch, hashMcpToken, newMcpToken,
  listApplicationBatches, listMcpTokens, recordApplicationReceipt, updateApplicationBatchItem, validBatchStatus,
} from './job-queue';
import { PRIVATE_API_HEADERS } from './job-mcp-api';
import { isPrivateAnalyticsPath } from './analytics-policy';

function fakeSql(rows: unknown[] = []) {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const query = (async (strings: TemplateStringsArray, ...args: unknown[]) => {
    statements.push(strings.join(' ? '));
    values.push(args);
    return rows;
  }) as unknown as NeonQueryFunction<false, false>;
  return { query, statements, values };
}

test('MCP tokens are high-entropy, stored as hashes, expire/revoke in lookup, and remain GitHub-allowlisted', async () => {
  const generated = newMcpToken();
  assert.match(generated.token, /^jobdesk_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(hashMcpToken(generated.token), generated.token);
  assert.equal(bearerToken(new Request('https://example.test', { headers: { authorization: `Bearer ${generated.token}` } })), generated.token);
  assert.equal(bearerToken(new Request('https://example.test', { headers: { authorization: 'Bearer jobdesk_bad' } })), null);

  const allowed = fakeSql([{ ownerId: '172521150' }]);
  assert.equal(await authenticateMcpToken(generated.token, allowed.query, new Set(['172521150'])), '172521150');
  assert.match(allowed.statements[0], /token_hash/);
  assert.match(allowed.statements[0], /revoked_at IS NULL/);
  assert.match(allowed.statements[0], /expires_at>now\(\)/);
  assert.deepEqual(allowed.values[0], [hashMcpToken(generated.token)]);

  const removed = fakeSql([{ ownerId: '172521150' }]);
  assert.equal(await authenticateMcpToken(generated.token, removed.query, new Set()), null);
  const revoked = fakeSql([]);
  assert.equal(await authenticateMcpToken(generated.token, revoked.query, new Set(['172521150'])), null);
});

test('batch creation selects only pursued leads and excludes any active or submitted application', async () => {
  const fake = fakeSql([{ batchId: 'batch' }]);
  const result = await createApplicationBatch('172521150', ['a'.repeat(64), 'a'.repeat(64), 'not-a-lead'], fake.query);
  assert.equal(result.count, 1);
  assert.match(fake.statements[0], /l\.decision='keep'/);
  assert.match(fake.statements[0], /previous\.status IN \('queued','preparing','awaiting_approval','submitted'\)/);
  assert.match(fake.statements[0], /previous\.owner_id/);
  assert.match(fake.statements[0], /job_application_batch_selections/);
  assert.match(fake.statements[0], /ON CONFLICT \(owner_id\) DO UPDATE/);
  assert.ok(fake.values[0].includes(JSON.stringify(['a'.repeat(64)])));
});

test('selected batch sorts ahead of the 50-batch history limit', async () => {
  const fake = fakeSql();
  await listApplicationBatches('172521150', fake.query);
  assert.match(fake.statements[0], /ORDER BY \(s\.batch_id=b\.id\) DESC,b\.created_at DESC LIMIT 50/);
});

test('MCP status updates reject submitted and submission receipts atomically count one weekly application', async () => {
  const noQuery = fakeSql();
  await assert.rejects(() => updateApplicationBatchItem('172521150', 'item', 'submitted', '', noQuery.query), /confirmed submission/);
  assert.equal(noQuery.statements.length, 0);
  assert.equal(validBatchStatus('awaiting_approval'), true);
  assert.equal(validBatchStatus('submitted'), true);
  assert.equal(validBatchStatus('unexpected'), false);

  const receipt = fakeSql([{ receiptId: 'receipt', idempotencyKey: 'receipt-1234' }]);
  const result = await recordApplicationReceipt('172521150', 'item', {
    idempotencyKey: 'receipt-1234', confirmation: 'Application received', confirmationUrl: 'https://jobs.example/confirmation',
  }, receipt.query);
  assert.equal(result.receiptId, 'receipt');
  assert.equal(receipt.statements.length, 1);
  assert.match(receipt.statements[0], /job_application_receipts/);
  assert.match(receipt.statements[0], /ON CONFLICT \(item_id\) DO NOTHING/);
  assert.match(receipt.statements[0], /job_review_events/);
  assert.match(receipt.statements[0], /ON CONFLICT \(lead_id,event_type,occurred_on\) DO NOTHING/);
  assert.match(receipt.statements[0], /job_application_batch_items/);
  assert.match(receipt.statements[0], /job_leads/);
  assert.match(receipt.statements[0], /America\/Chicago/);
  assert.ok(receipt.values[0].includes('172521150'));
  await assert.rejects(() => recordApplicationReceipt('172521150', 'item', { idempotencyKey: 'short', confirmation: '' }, receipt.query), /idempotency key/);
});

test('MCP routes authenticate independently and expose no application submission route', async () => {
  const routePaths = [
    '../app/api/jobs/mcp/batches/route.ts',
    '../app/api/jobs/mcp/batches/[batchId]/items/route.ts',
    '../app/api/jobs/mcp/items/[itemId]/route.ts',
    '../app/api/jobs/mcp/items/[itemId]/submission/route.ts',
  ];
  for (const routePath of routePaths) {
    const source = await readFile(new URL(routePath, import.meta.url), 'utf8');
    assert.match(source, /mcpOwner\(request\)/, routePath);
    assert.match(source, /privateJson\(/, routePath);
  }
  const submissionRoute = await readFile(new URL('../app/api/jobs/mcp/items/[itemId]/submission/route.ts', import.meta.url), 'utf8');
  assert.match(submissionRoute, /recordApplicationReceipt/);
  assert.doesNotMatch(submissionRoute, /fetch\(|submit.*application/i);
});

test('token responses are private, settings analytics are disabled, and token lists never return credentials', async () => {
  assert.equal(PRIVATE_API_HEADERS['Cache-Control'], 'private, no-store, max-age=0');
  assert.equal(isPrivateAnalyticsPath('/jobs/settings'), true);
  const fake = fakeSql();
  await listMcpTokens('172521150', fake.query);
  assert.match(fake.statements[0], /id,label,expires_at/);
  assert.doesNotMatch(fake.statements[0], /token_hash/);
  const analytics = await readFile(new URL('./analytics-client.ts', import.meta.url), 'utf8');
  assert.match(analytics, /autocapture:\s*false/);
});
