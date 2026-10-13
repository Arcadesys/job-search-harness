import assert from 'node:assert/strict';
import test from 'node:test';
import type { Sql } from './job-storage';
import {
  createApplicationBatch, listApplicationBatches, recordApplicationReceipt, updateApplicationBatchItem, validBatchStatus,
} from './job-queue';

function fakeSql(rows: unknown[] = []) {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const query = (async (strings: TemplateStringsArray, ...args: unknown[]) => {
    statements.push(strings.join(' ? '));
    values.push(args);
    return rows;
  }) as unknown as Sql;
  return { query, statements, values };
}

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

