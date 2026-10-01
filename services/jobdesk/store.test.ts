import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JobdeskStore, recoverOwnerLock } from './store';
import { MIGRATIONS, migrate } from './migrate';
import { createService, initializeService, LOCAL_OWNER } from './service';
import { leadIdForUrl } from '../../lib/job-discovery';
import { fixtureReports } from '../../tests/fixtures/jobdesk-reports';
import { createReviewPacket } from './artifacts';

test('real disk: migrations, fresh approvals, leases, uncertainty, atomic receipts, snapshots, backup and restart', async () => {
  const root = await mkdtemp('/tmp/jobdesk-disk-');
  let store = await JobdeskStore.open(root);
  const restored = await mkdtemp('/tmp/jobdesk-restore-');
  let restoredStore: JobdeskStore | undefined;
  const cliRestored = await mkdtemp('/tmp/jobdesk-cli-restore-');
  try {
    await fixtureReports(root);
    await initializeService(store);
    let call = createService(store);
    assert.equal(
      (await store.sql`SELECT count(*)::int AS count FROM jobdesk_migrations`)[0].count,
      9,
    );
    await assert.rejects(JobdeskStore.open(root), /owner/);
    assert.equal((await stat(path.join(root, 'owner.lock'))).mode & 0o777, 0o600);
    const claims = (await call({ method: 'truth.list', args: [] })) as any[];
    assert.ok(claims.length > 40);
    assert.ok(claims.every((c) => c.reviewStatus === 'unreviewed'));
    const reports = await store.sql`SELECT state FROM jobdesk_user_reports`;
    assert.equal(reports.filter((r) => r.state === 'user_reported_submitted').length, 2);
    assert.equal(reports.filter((r) => r.state === 'referral_expected').length, 1);
    assert.equal(
      (await store.sql`SELECT count(*)::int AS count FROM job_application_receipts`)[0].count,
      0,
    );
    const change = {
      id: claims[0].id,
      expectedVersion: claims[0].version,
      reviewStatus: 'reviewed',
    };
    const reviews = (await Promise.all([
      call({ method: 'truth.review', args: [{ changes: [change] }] }),
      call({ method: 'truth.review', args: [{ changes: [change] }] }),
    ])) as any[];
    assert.equal(reviews.filter((r) => r.conflicts.length === 0).length, 1);
    assert.equal(reviews.filter((r) => r.conflicts.length === 1).length, 1);
    const snapshot = ((await call({ method: 'truth.list', args: [] })) as any[]).filter(
      (c) => c.reviewStatus === 'reviewed',
    );
    const url = 'https://example.test/jobs/local-fixture';
    const leadId = leadIdForUrl(url);
    await call({
      method: 'leads.add',
      args: [{ url, title: 'Local test fixture', organization: 'Test fixture' }],
    });
    await call({ method: 'leads.update', args: [{ id: leadId, decision: 'keep' }] });
    const batch = (await call({ method: 'batches.create', args: [[leadId, leadId]] })) as any;
    assert.equal(batch.count, 1);
    await assert.rejects(call({ method: 'batches.create', args: [[leadId]] }));
    const items = (await call({ method: 'batches.items', args: [batch.id] })) as any;
    const itemId = items.items[0].itemId;
    assert.equal(
      ((await call({ method: 'items.read', args: [itemId] })) as any).item.reviewedTruths.length,
      1,
    );
    const contenders = await Promise.allSettled(
      ['worker-one', 'worker-two'].map((workerId) =>
        call({ method: 'items.claim', args: [{ itemId, workerId }] }),
      ),
    );
    assert.equal(contenders.filter((c) => c.status === 'fulfilled').length, 1);
    const won = contenders.find((c) => c.status === 'fulfilled') as PromiseFulfilledResult<any>;
    let lease = { itemId, workerId: won.value.workerId, generation: won.value.generation };
    await assert.rejects(
      call({
        method: 'items.status',
        args: [{ ...lease, generation: '0', status: 'preparing', note: '' }],
      }),
    );
    await call({ method: 'items.renew', args: [lease] });
    await store.sql`UPDATE job_application_batch_items SET lease_expires_at=now()-interval '1 second' WHERE id=${itemId}`;
    const reacquired = (await call({
      method: 'items.claim',
      args: [{ itemId, workerId: 'replacement' }],
    })) as any;
    await assert.rejects(call({ method: 'items.renew', args: [lease] }));
    lease = { itemId, workerId: reacquired.workerId, generation: reacquired.generation };
    await assert.rejects(call({ method: 'submission.begin', args: [{ ...lease,
      draftVersion: 'missing-draft', draftHash: '0'.repeat(64) }] }), /Draft/);
    await store.sql`INSERT INTO job_application_drafts(lead_id,resume_variant,outreach,claim_ids,truth_snapshot)
      VALUES(${leadId},${snapshot[0].claim},'Fixture outreach',${snapshot.map((c) => c.id)},${JSON.stringify(snapshot)}::jsonb)`;
    let draft = (await call({ method: 'draft.read', args: [leadId] })) as any;
    await store.sql`UPDATE job_application_drafts SET truth_snapshot='[]'::jsonb WHERE lead_id=${leadId}`;
    await assert.rejects(call({ method: 'draft.approve', args: [leadId, draft.approval.version] }));
    await store.sql`UPDATE job_application_drafts SET truth_snapshot=${JSON.stringify(snapshot)}::jsonb WHERE lead_id=${leadId}`;
    await call({
      method: 'items.status',
      args: [{ ...lease, status: 'awaiting_approval', note: 'Fixture awaits saved draft review.' }],
    });
    await assert.rejects(
      call({ method: 'items.claim', args: [{ itemId, workerId: 'after-review' }] }),
    );
    await call({ method: 'draft.approve', args: [leadId, draft.approval.version] });
    const resumed = (await call({
      method: 'items.claim',
      args: [{ itemId, workerId: 'after-review' }],
    })) as any;
    lease = { itemId, workerId: resumed.workerId, generation: resumed.generation };
    const packet = (await call({ method: 'draft.pdf', args: [leadId] })) as any;
    assert.equal(packet.approvalState, 'review_required');
    assert.match(
      (await readFile(path.join(root, packet.relativePath))).subarray(0, 5).toString(),
      /^%PDF-/,
    );
    const read = (await call({ method: 'items.read', args: [itemId] })) as any;
    const attempt = (await call({ method: 'submission.begin', args: [{ ...lease,
      draftVersion: read.item.draftVersion, draftHash: read.item.draftHash }] })) as any;
    await call({
      method: 'submission.uncertain',
      args: [attempt.id, 'Fixture timeout after intended submit. No employer contacted.'],
    });
    await assert.rejects(call({ method: 'items.requeue', args: [itemId, 'retry'] }));
    await assert.rejects(call({ method: 'items.claim', args: [{ itemId, workerId: 'third' }] }));
    await assert.rejects(call({ method: 'batches.create', args: [[leadId]] }));
    const input = {
      itemId,
      idempotencyKey: 'fixture-receipt-0001',
      confirmation: 'Synthetic test confirmation. No real application.',
      attemptId: attempt.id,
    };
    const receipts = (await Promise.all([
      call({ method: 'submission.record', args: [input] }),
      call({ method: 'submission.record', args: [input] }),
    ])) as any[];
    assert.equal(receipts[0].receiptId, receipts[1].receiptId);
    await assert.rejects(
      call({
        method: 'submission.record',
        args: [{ ...input, idempotencyKey: 'different-fixture-key' }],
      }),
    );
    assert.equal(
      (await store.sql`SELECT count(*)::int AS count FROM job_application_receipts`)[0].count,
      1,
    );
    assert.equal(
      (
        await store.sql`SELECT count(*)::int AS count FROM job_review_events WHERE event_type='application'`
      )[0].count,
      1,
    );
    assert.equal(
      (await store.sql`SELECT application_stage FROM job_leads WHERE id=${leadId}`)[0]
        .application_stage,
      'applied',
    );
    assert.equal(
      (await store.sql`SELECT state FROM jobdesk_submission_attempts WHERE id=${attempt.id}`)[0]
        .state,
      'confirmed',
    );
    assert.equal(
      (await store.sql`SELECT status FROM job_application_batch_items WHERE id=${itemId}`)[0]
        .status,
      'submitted',
    );
    await assert.rejects(call({ method: 'items.requeue', args: [itemId, 'retry'] }));
    await assert.rejects(call({ method: 'items.claim', args: [{ itemId, workerId: 'third' }] }));
    const newClaim = ((await call({ method: 'truth.list', args: [] })) as any[]).find(
      (c) => c.id === snapshot[0].id,
    );
    await call({
      method: 'truth.review',
      args: [
        {
          changes: [
            {
              id: newClaim.id,
              expectedVersion: newClaim.version,
              reviewStatus: 'unreviewed',
              claim: 'Fixture changed claim',
            },
          ],
        },
      ],
    });
    draft = (await call({ method: 'draft.read', args: [leadId] })) as any;
    assert.equal(draft.history.draft.truthSnapshot[0].claim, snapshot[0].claim);
    await assert.rejects(call({ method: 'draft.approve', args: [leadId, draft.approval.version] }));
    const backup = await store.backup();
    assert.ok(backup.manifest.artifacts.length === 1);
    assert.equal((await stat(path.join(backup.directory, 'database.tar.gz'))).mode & 0o777, 0o600);
    const logical = JSON.parse(await readFile(path.join(backup.directory, 'logical.json'), 'utf8'));
    assert.equal(logical.job_mcp_tokens, undefined);
    restoredStore = await JobdeskStore.open(
      restored,
      undefined,
      new Blob([new Uint8Array(await readFile(path.join(backup.directory, 'database.tar.gz')))]),
    );
    assert.equal(
      (await restoredStore.sql`SELECT count(*)::int AS count FROM job_application_receipts`)[0]
        .count,
      1,
    );
    await restoredStore.close();
    restoredStore = undefined;
    await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'services/jobdesk/cli.ts', 'restore', backup.directory, cliRestored],
      { cwd: process.cwd() },
    );
    assert.deepEqual(
      await readFile(path.join(cliRestored, packet.relativePath)),
      await readFile(path.join(root, packet.relativePath)),
    );
    await store.close();
    store = await JobdeskStore.open(root);
    await initializeService(store);
    call = createService(store);
    assert.equal(
      ((await call({ method: 'items.read', args: [itemId] })) as any).item.status,
      'submitted',
    );
    assert.equal(
      (await store.sql`SELECT count(*)::int AS count FROM jobdesk_user_reports`)[0].count,
      3,
    );
    assert.equal(
      (await store.sql`SELECT owner_id FROM job_application_receipts`)[0].owner_id,
      LOCAL_OWNER,
    );
    const persisted = (await store.sql`SELECT attempt_id,draft_version,draft_hash FROM job_application_receipts`)[0];
    assert.equal(persisted.attempt_id, attempt.id);
    assert.equal(persisted.draft_version, read.item.draftVersion);
    assert.equal(persisted.draft_hash, read.item.draftHash);
    // URL-deduped imports preserve source status and do not turn user reports
    // into fabricated browser receipts or queue either reported application.
    const blockedUrl = 'https://example.test/jobs/fixture-role-001';
    const blockedId = leadIdForUrl(blockedUrl);
    await call({
      method: 'leads.add',
      args: [{ url: blockedUrl, title: 'Reported role fixture' }],
    });
    await call({ method: 'leads.update', args: [{ id: blockedId, decision: 'keep' }] });
    await assert.rejects(
      call({ method: 'batches.create', args: [[blockedId]] }),
      /already reported/,
    );
    const email = {
      title: 'Email fixture',
      organization: 'Fixture',
      location: 'Remote',
      url: 'https://linkedin.com/jobs/view/999999999',
    };
    await call({ method: 'leads.import', args: [[email, email]] });
    await call({ method: 'leads.import', args: [[email]] });
    assert.equal(
      (
        await store.sql`SELECT count(*)::int AS count FROM job_leads WHERE source='linkedin-email'`
      )[0].count,
      1,
    );
  } finally {
    await restoredStore?.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(restored, { recursive: true, force: true });
    await rm(cliRestored, { recursive: true, force: true });
  }
});

test('migration drift, unknown schema, failed DDL rollback and explicit crash-lock recovery', async () => {
  const root = await mkdtemp('/tmp/jobdesk-ledger-'),
    directory = await mkdtemp('/tmp/jobdesk-migrations-');
  await cp(MIGRATIONS, directory, { recursive: true });
  let store = await JobdeskStore.open(root, directory);
  try {
    const original = await readFile(path.join(directory, '0001_resume_truth.sql'), 'utf8');
    await writeFile(path.join(directory, '0001_resume_truth.sql'), original + '\n-- drift');
    await assert.rejects(migrate(store.db, directory), /checksum drift/);
    await writeFile(path.join(directory, '0001_resume_truth.sql'), original);
    await writeFile(
      path.join(directory, '0010_failure.sql'),
      'CREATE TABLE jobdesk_should_rollback(id text); SELECT no_such_column;',
    );
    await assert.rejects(migrate(store.db, directory));
    assert.equal(
      (await store.sql`SELECT to_regclass('jobdesk_should_rollback') AS table`)[0].table,
      null,
    );
    assert.equal(
      (await store.sql`SELECT count(*)::int AS count FROM jobdesk_migrations`)[0].count,
      9,
    );
    await rm(path.join(directory, '0010_failure.sql'));
    await store.sql`INSERT INTO jobdesk_migrations(version,checksum) VALUES('9999_newer.sql','fixture')`;
    await assert.rejects(migrate(store.db, directory), /newer/);
    await store.sql`DELETE FROM jobdesk_migrations WHERE version='9999_newer.sql'`;
    const missing=(await store.sql`SELECT checksum FROM jobdesk_migrations WHERE version='0002_job_discovery.sql'`)[0];
    await store.sql`DELETE FROM jobdesk_migrations WHERE version='0002_job_discovery.sql'`;
    await assert.rejects(migrate(store.db,directory),/gap/);
    await store.sql`INSERT INTO jobdesk_migrations(version,checksum) VALUES('0002_job_discovery.sql',${missing.checksum})`;
    await assert.rejects(recoverOwnerLock(root), /still running/);
    await store.close();
    await writeFile(path.join(root, 'owner.lock'), JSON.stringify({ pid: 2147483647 }), {
      mode: 0o600,
    });
    await assert.rejects(JobdeskStore.open(root), /owner/);
    await recoverOwnerLock(root);
    store = await JobdeskStore.open(root, directory);
    await writeFile(
      path.join(directory, '0010_upgrade.sql'),
      'CREATE TABLE jobdesk_upgrade_proof(id text);',
    );
    await store.close();
    store = await JobdeskStore.open(root, directory);
    assert.equal(
      (await store.sql`SELECT count(*)::int AS count FROM jobdesk_migrations`)[0].count,
      10,
    );
    const backups = await import('node:fs/promises').then((fs) =>
      fs.readdir(path.join(root, 'backups')),
    );
    assert.equal(backups.length, 1);
    const manifest = JSON.parse(
      await readFile(path.join(root, 'backups', backups[0], 'manifest.json'), 'utf8'),
    );
    assert.equal(manifest.migrations.length, 9);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('actual CLI restore stages a real 0008 backup artifact before migration 0009 upgrade backup', async () => {
  const root = await mkdtemp('/tmp/jobdesk-legacy-'),
    directory = await mkdtemp('/tmp/jobdesk-legacy-migrations-'),
    restored = await mkdtemp('/tmp/jobdesk-legacy-restored-');
  await cp(MIGRATIONS, directory, { recursive: true });
  await rm(path.join(directory, '0009_submission_draft_binding.sql'));
  const legacy = await JobdeskStore.open(root, directory);
  let current: JobdeskStore | undefined;
  try {
    await initializeService(legacy);
    const call = createService(legacy);
    const claims = (await call({ method: 'truth.list', args: [] })) as any[];
    const url = 'https://example.test/jobs/legacy-restore-fixture', leadId = leadIdForUrl(url);
    await call({ method: 'leads.add', args: [{ url, title: 'Synthetic legacy restore' }] });
    await legacy.sql`INSERT INTO job_application_drafts(lead_id,resume_variant,outreach,claim_ids,truth_snapshot)
      VALUES(${leadId},${claims[0].claim},'Synthetic legacy outreach',${[claims[0].id]},${JSON.stringify([claims[0]])}::jsonb)`;
    const packet = await createReviewPacket(root, leadId, legacy.sql);
    const bytes = await readFile(path.join(root, packet.relativePath));
    const backup = await legacy.backup();
    assert.equal(backup.manifest.migrations.length, 8);
    assert.equal(backup.manifest.artifacts.length, 1);
    await legacy.close();
    await promisify(execFile)(process.execPath,
      ['--import', 'tsx', 'services/jobdesk/cli.ts', 'restore', backup.directory, restored],
      { cwd: process.cwd() });
    current = await JobdeskStore.open(restored);
    assert.equal((await current.sql`SELECT count(*)::int AS count FROM jobdesk_migrations`)[0].count, 9);
    assert.deepEqual(await readFile(path.join(restored, packet.relativePath)), bytes);
    assert.equal((await stat(path.join(restored, packet.relativePath))).mode & 0o777, 0o600);
    const preUpgrade = await readdir(path.join(restored, 'backups'));
    assert.equal(preUpgrade.length, 1);
    const preUpgradeRoot = path.join(restored, 'backups', preUpgrade[0]);
    const manifest = JSON.parse(await readFile(path.join(preUpgradeRoot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.migrations.length, 8);
    assert.equal(manifest.artifacts[0].content_hash, packet.contentHash);
    assert.deepEqual(await readFile(path.join(preUpgradeRoot, packet.relativePath)), bytes);
  } finally {
    await legacy.close();
    await current?.close();
    await rm(root, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
    await rm(restored, { recursive: true, force: true });
  }
});
