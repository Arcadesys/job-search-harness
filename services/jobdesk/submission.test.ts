import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { startJobdesk } from './server';
import { brokerCall } from './client';
import { leadIdForUrl } from '../../lib/job-discovery';

test('submission binds the worker-read draft; stale forms fail and receipts preserve the attempt snapshot', async () => {
  const root = await mkdtemp('/tmp/jobdesk-submission-');
  const runtime = await startJobdesk({ root });
  let stopped = false;
  const call = (method: any, args: any[] = []) => runtime.service({ method, args }) as Promise<any>;
  const sql = runtime.store.sql;
  const adapter = await import('./mcp-client.mjs' as string);
  const clients = () => adapter.createLocalApiClient({ socketPath: runtime.socketPath });
  const preparing = (client: any, itemId: string) => client('PATCH', `/api/jobs/mcp/items/${itemId}`, { status: 'preparing' });
  const workerTool = (client: any, name: string) => client.workerTools.find((tool: any) => tool.name === name).run;
  try {
    const claims = await call('truth.list');
    await call('truth.review', [{ changes: [{ id: claims[0].id, expectedVersion: claims[0].version, reviewStatus: 'reviewed' }] }]);
    let snapshot = (await call('truth.list')).filter((claim: any) => claim.reviewStatus === 'reviewed');
    const fixture = async (name: string) => {
      const url = `https://example.test/jobs/${name}`, leadId = leadIdForUrl(url);
      await call('leads.add', [{ url, title: `Synthetic ${name}` }]);
      await call('leads.update', [{ id: leadId, decision: 'keep' }]);
      const batch = await call('batches.create', [[leadId]]);
      const { items } = await call('batches.items', [batch.id]);
      const itemId = items[0].itemId;
      await sql`INSERT INTO job_application_drafts(lead_id,resume_variant,outreach,claim_ids,truth_snapshot)
        VALUES(${leadId},${snapshot[0].claim},'Synthetic outreach',${snapshot.map((claim: any) => claim.id)},${JSON.stringify(snapshot)}::jsonb)`;
      const draft = await call('draft.read', [leadId]);
      await call('draft.approve', [leadId, draft.approval.version]);
      return { leadId, itemId };
    };
    const first = await fixture('draft-race');
    const worker = clients();
    await preparing(worker, first.itemId);
    const readA = (await worker('GET', `/api/jobs/mcp/items/${first.itemId}`)).item;
    assert.equal(readA.draftReviewStatus, 'approved');
    assert.match(readA.draftHash, /^[a-f0-9]{64}$/);
    // Worker filled A. User changes its claim, regenerates and approves B.
    await call('truth.review', [{ changes: [{ id: snapshot[0].id, expectedVersion: snapshot[0].version,
      claim: 'Synthetic revised claim B', reviewStatus: 'reviewed' }] }]);
    snapshot = (await call('truth.list')).filter((claim: any) => claim.reviewStatus === 'reviewed');
    await call('draft.edit', [first.leadId, snapshot[0].claim, 'Synthetic outreach B']);
    await sql`UPDATE job_application_drafts SET truth_snapshot=${JSON.stringify(snapshot)}::jsonb,updated_at=clock_timestamp() WHERE lead_id=${first.leadId}`;
    const draftB = await call('draft.read', [first.leadId]);
    await call('draft.approve', [first.leadId, draftB.approval.version]);
    const readB = (await worker('GET', `/api/jobs/mcp/items/${first.itemId}`)).item;
    assert.notEqual(readA.draftVersion, readB.draftVersion);
    assert.notEqual(readA.draftHash, readB.draftHash);
    const begin = workerTool(worker, 'job_hunt_begin_submission');
    await assert.rejects(begin({ itemId: first.itemId, draftVersion: readA.draftVersion, draftHash: readA.draftHash }),
      (error: any) => error.code === 'STALE_DRAFT');
    await assert.rejects(begin({ itemId: first.itemId, draftVersion: readB.draftVersion, draftHash: readA.draftHash }),
      (error: any) => error.code === 'STALE_DRAFT');
    assert.equal((await sql`SELECT count(*)::int AS count FROM jobdesk_submission_attempts`)[0].count, 0);
    // Refilling from B now permits an attempt explicitly bound to B.
    const attempt = await begin({ itemId: first.itemId, draftVersion: readB.draftVersion, draftHash: readB.draftHash });
    assert.equal(attempt.draftHash, readB.draftHash);
    await call('draft.edit', [first.leadId, 'Synthetic draft C after begin', 'Synthetic outreach C']);
    const { receipt } = await worker('POST', `/api/jobs/mcp/items/${first.itemId}/submission`, {
      idempotencyKey: 'bound-receipt-fixture', confirmation: 'Synthetic confirmation; no employer contacted.' });
    assert.equal(receipt.attemptId, attempt.id);
    assert.equal(receipt.draftHash, readB.draftHash);
    const bound = (await sql`SELECT a.draft_snapshot,a.draft_version,a.draft_hash,r.attempt_id,r.draft_hash AS receipt_hash
      FROM jobdesk_submission_attempts a JOIN job_application_receipts r ON r.attempt_id=a.id WHERE a.id=${attempt.id}`)[0];
    assert.equal(bound.draft_snapshot.resumeVariant, readB.resumeVariant);
    assert.equal(bound.draft_version, readB.draftVersion);
    assert.equal(bound.receipt_hash, bound.draft_hash);

    const second = await fixture('pending-reconcile');
    const lease = await call('items.claim', [{ itemId: second.itemId, workerId: 'pending-fixture' }]);
    const binding = { draftVersion: lease.draftVersion, draftHash: lease.draftHash };
    const leaseInput = { itemId: second.itemId, workerId: lease.workerId, generation: lease.generation };
    const pending = await call('submission.begin', [{ ...leaseInput, ...binding }]);
    await call('submission.notSubmitted', [pending.id, 'Synthetic employer history proves no application.']);
    const blocked = (await sql`SELECT status,lease_worker,lease_expires_at,lease_generation::text AS generation FROM job_application_batch_items WHERE id=${second.itemId}`)[0];
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.lease_worker, null);
    assert.equal(blocked.lease_expires_at, null);
    assert.ok(BigInt(blocked.generation) > BigInt(lease.generation));
    await assert.rejects(call('submission.begin', [{ ...leaseInput, ...binding }]), (error: any) => error.code === 'STALE_LEASE');
    await assert.rejects(call('items.renew', [leaseInput]), (error: any) => error.code === 'STALE_LEASE');
    await assert.rejects(call('items.claim', [{ itemId: second.itemId, workerId: 'must-requeue' }]));
    assert.equal((await sql`SELECT count(*)::int AS count FROM jobdesk_submission_attempts WHERE item_id=${second.itemId}`)[0].count, 1);
    await call('items.requeue', [second.itemId, 'Deliberate synthetic preparation requeue.']);
    const newLease = await call('items.claim', [{ itemId: second.itemId, workerId: 'after-requeue' }]);
    const newInput = { itemId: second.itemId, workerId: newLease.workerId, generation: newLease.generation };
    const newAttempt = await call('submission.begin', [{ ...newInput, ...binding }]);
    await call('submission.uncertain', [newAttempt.id, 'Synthetic uncertainty; no employer contacted.']);
    await call('submission.notSubmitted', [newAttempt.id, 'Synthetic history reconciliation after uncertainty.']);
    assert.equal((await call('items.read', [second.itemId])).item.status, 'blocked');
    await assert.rejects(call('submission.begin', [{ ...newInput, ...binding }]), (error: any) => error.code === 'STALE_LEASE');

    const third = await fixture('adapter-reacquire');
    const longLived = clients();
    const initial = await preparing(longLived, third.itemId);
    await sql`UPDATE job_application_batch_items SET lease_expires_at=now()-interval '1 second' WHERE id=${third.itemId}`;
    await assert.rejects(workerTool(longLived, 'job_hunt_renew_lease')({ itemId: third.itemId }),
      (error: any) => error.code === 'STALE_LEASE');
    const renewed = await preparing(longLived, third.itemId);
    assert.ok(BigInt(renewed.item.lease.generation) > BigInt(initial.item.lease.generation));
    await sql`UPDATE job_application_batch_items SET lease_expires_at=now()-interval '1 second' WHERE id=${third.itemId}`;
    const statusRecovered = await preparing(longLived, third.itemId);
    assert.ok(BigInt(statusRecovered.item.lease.generation) > BigInt(renewed.item.lease.generation));
    const read = (await longLived('GET', `/api/jobs/mcp/items/${third.itemId}`)).item;
    const inFlight = await workerTool(longLived, 'job_hunt_begin_submission')({ itemId: third.itemId,
      draftVersion: read.draftVersion, draftHash: read.draftHash });
    await sql`UPDATE job_application_batch_items SET lease_expires_at=now()-interval '1 second' WHERE id=${third.itemId}`;
    await assert.rejects(workerTool(longLived, 'job_hunt_renew_lease')({ itemId: third.itemId }),
      (error: any) => error.code === 'SUBMISSION_RECONCILIATION_REQUIRED');
    await assert.rejects(preparing(longLived, third.itemId), (error: any) => error.code === 'SUBMISSION_RECONCILIATION_REQUIRED');
    await workerTool(longLived, 'job_hunt_mark_submission_uncertain')({ attemptId: inFlight.id,
      note: 'Synthetic timeout after begin; do not submit again.' });
    await assert.rejects(preparing(longLived, third.itemId));
    assert.equal((await sql`SELECT lease_generation::text AS generation FROM job_application_batch_items WHERE id=${third.itemId}`)[0].generation,
      statusRecovered.item.lease.generation);
    assert.equal((await sql`SELECT count(*)::int AS count FROM jobdesk_submission_attempts WHERE item_id=${third.itemId}`)[0].count, 1);
    await assert.rejects(brokerCall('items.claim', [{ itemId: third.itemId, workerId: 'new-process' }], runtime.socketPath));
    // Keep this exact adapter alive through reconciliation and explicit requeue.
    // Reconciliation alone cannot clear its barrier; the broker's queued state
    // and matching not_submitted attempt together permit a fresh generation.
    await call('submission.notSubmitted', [inFlight.id, 'Synthetic history proves no application was submitted.']);
    await assert.rejects(preparing(longLived, third.itemId));
    await assert.rejects(workerTool(longLived, 'job_hunt_begin_submission')({ itemId: third.itemId,
      draftVersion: read.draftVersion, draftHash: read.draftHash }), /may have begun/);
    await call('items.requeue', [third.itemId, 'Explicit synthetic user requeue.']);
    const afterRequeue = await preparing(longLived, third.itemId);
    assert.ok(BigInt(afterRequeue.item.lease.generation) > BigInt(statusRecovered.item.lease.generation));
    const nextAttempt = await workerTool(longLived, 'job_hunt_begin_submission')({ itemId: third.itemId,
      draftVersion: read.draftVersion, draftHash: read.draftHash });
    assert.notEqual(nextAttempt.id, inFlight.id);
    assert.equal((await sql`SELECT count(*)::int AS count FROM jobdesk_submission_attempts WHERE item_id=${third.itemId}`)[0].count, 2);
    await call('submission.notSubmitted', [nextAttempt.id, 'Synthetic pending-attempt reconciliation confirms no application.']);
    await assert.rejects(preparing(longLived, third.itemId));
    await call('items.requeue', [third.itemId, 'Explicit synthetic second user requeue.']);
    await preparing(longLived, third.itemId);
    const thirdAttempt = await workerTool(longLived, 'job_hunt_begin_submission')({ itemId: third.itemId,
      draftVersion: read.draftVersion, draftHash: read.draftHash });
    assert.notEqual(thirdAttempt.id, nextAttempt.id);

    // Receipt binding is part of the same short transaction as the original
    // receipt/event/applied-stage write. A binding failure rolls everything back.
    const fourth = await fixture('receipt-rollback');
    const fourthLease = await call('items.claim', [{ itemId: fourth.itemId, workerId: 'rollback-fixture' }]);
    const fourthAttempt = await call('submission.begin', [{ itemId: fourth.itemId, workerId: fourthLease.workerId,
      generation: fourthLease.generation, draftVersion: fourthLease.draftVersion, draftHash: fourthLease.draftHash }]);
    await sql`ALTER TABLE job_application_receipts ADD CONSTRAINT fixture_reject_binding CHECK(draft_hash IS NULL) NOT VALID`;
    await assert.rejects(call('submission.record', [{ itemId: fourth.itemId, attemptId: fourthAttempt.id,
      idempotencyKey: 'atomic-binding-fixture', confirmation: 'Synthetic observed confirmation.' }]));
    assert.equal((await sql`SELECT count(*)::int AS count FROM job_application_receipts WHERE item_id=${fourth.itemId}`)[0].count, 0);
    assert.equal((await sql`SELECT count(*)::int AS count FROM job_review_events WHERE lead_id=${fourth.leadId} AND event_type='application'`)[0].count, 0);
    assert.notEqual((await sql`SELECT application_stage FROM job_leads WHERE id=${fourth.leadId}`)[0].application_stage, 'applied');
    assert.equal((await sql`SELECT state FROM jobdesk_submission_attempts WHERE id=${fourthAttempt.id}`)[0].state, 'pending');
    await sql`ALTER TABLE job_application_receipts DROP CONSTRAINT fixture_reject_binding`;

    const fifth = await fixture('transport-ambiguity');
    const disconnected = clients();
    const fifthLease = await preparing(disconnected, fifth.itemId);
    await runtime.close();
    stopped = true;
    const dispatch = { itemId: fifth.itemId, draftVersion: fifthLease.item.lease.draftVersion,
      draftHash: fifthLease.item.lease.draftHash };
    await assert.rejects(workerTool(disconnected, 'job_hunt_begin_submission')(dispatch), /unavailable/);
    await assert.rejects(workerTool(disconnected, 'job_hunt_begin_submission')(dispatch), /may have begun/);
  } finally {
    if (!stopped) await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
