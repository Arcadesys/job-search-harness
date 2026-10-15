import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { startJobdesk } from './server';
import { localCall, currentTool } from './mcp-client.mjs';
import { describeCall, recordActivity } from './cockpit';
import { JobdeskStore } from './store';
import { migrationsDirectory } from './migrate';
const MIGRATIONS = migrationsDirectory();
import { createService, initializeService } from './service';
import { leadIdForUrl } from '../../lib/job-discovery';
import { tempRoot } from '../../tests/fixtures/temp-root';
import { sampleResume } from '../../tests/fixtures/sample-resume';

test('worker calls become structural activity, live leases and pipeline stages', async () => {
  const root = await tempRoot('jobdesk-cockpit-');
  const runtime = await startJobdesk({ root });
  try {
    const service = (method: any, args: any[] = []) => runtime.service({ method, args }) as Promise<any>;
    const worker = (tool: string, method: string, args: unknown[]) =>
      currentTool.run(tool, () => localCall(method, args, runtime.socketPath)) as Promise<any>;
    await service('truth.importResume', [sampleResume]);
    const url = 'https://example.test/jobs/cockpit', leadId = leadIdForUrl(url);
    await service('leads.add', [{ url, title: 'Synthetic cockpit fixture', organization: 'Fixture Co' }]);
    assert.equal((await service('cockpit.live')).counts.leads, 1);
    await service('leads.update', [{ id: leadId, decision: 'keep' }]);
    let pipeline = await service('cockpit.pipeline');
    assert.equal(pipeline.jobs[0].stage, 2);
    assert.deepEqual(pipeline.stages.length, 6);

    const batch = await service('batches.create', [[leadId]]);
    const itemId = (await service('batches.items', [batch.id])).items[0].itemId;
    await worker('job_hunt_update_item_status', 'items.claim', [{ itemId, workerId: 'cockpit-fixture' }]);
    await assert.rejects(worker('job_hunt_get_item', 'items.read', ['not-a-uuid']));
    const live = await service('cockpit.live');
    const [rejected, claimed] = live.events;
    assert.equal(claimed.tool, 'job_hunt_update_item_status');
    assert.equal(claimed.kind, 'lease');
    assert.equal(claimed.organization, 'Fixture Co');
    assert.equal(rejected.kind, 'error');
    assert.equal(rejected.ok, false);
    assert.equal(live.leases.length, 1);
    assert.equal(live.leases[0].leadId, leadId);
    pipeline = await service('cockpit.pipeline');
    assert.equal(pipeline.jobs[0].stage, 3);
    assert.equal(pipeline.jobs[0].leased, true);
    assert.equal((await service('cockpit.lead', [leadId])).lease.itemId, itemId);
    assert.deepEqual((await service('cockpit.reconcile')).attempts, []);
    // A reported application stage is not an employer confirmation receipt.
    await service('leads.update', [{ id: leadId, decision: 'keep', stage: 'applied' }]);
    pipeline = await service('cockpit.pipeline');
    assert.equal(pipeline.jobs[0].applicationStage, 'applied');
    assert.equal(pipeline.jobs[0].stage, 3);
    assert.equal(pipeline.funnel.receipts, 0);
    // Browser calls are not assistant activity.
    assert.equal((await service('cockpit.live')).events.length, 2);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('current main stores upgrade to cockpit activity without changing saved truths or leads', async () => {
  const root = await tempRoot('jobdesk-cockpit-up-');
  const previousMigrations = await tempRoot('jobdesk-cockpit-schema-');
  let store: JobdeskStore | undefined;
  try {
    // Reproduce the shipped 13-migration schema, not a fresh redesigned store.
    await cp(MIGRATIONS, previousMigrations, { recursive: true,
      filter: filename => path.basename(filename) !== '0014_assistant_activity.sql' });
    store = await JobdeskStore.open(root, previousMigrations);
    await initializeService(store);
    const service = createService(store);
    await service({ method: 'truth.importResume', args: [sampleResume] });
    await service({ method: 'leads.add', args: [{ url: 'https://example.test/cockpit-upgrade', title: 'Fictional upgrade fixture' }] });
    const truths = await store.sql`SELECT * FROM resume_truth_claims ORDER BY id`;
    const leads = await store.sql`SELECT * FROM job_leads ORDER BY id`;
    const ledger = await store.sql`SELECT version,checksum FROM jobdesk_migrations ORDER BY version`;
    assert.equal(ledger.length, 13);
    await store.close(); store = undefined;

    store = await JobdeskStore.open(root);
    const updated = await store.sql`SELECT version,checksum FROM jobdesk_migrations ORDER BY version`;
    assert.deepEqual(updated.slice(0, ledger.length), ledger);
    assert.equal(updated.at(-1)?.version, '0014_assistant_activity.sql');
    assert.deepEqual(await store.sql`SELECT * FROM resume_truth_claims ORDER BY id`, truths);
    assert.deepEqual(await store.sql`SELECT * FROM job_leads ORDER BY id`, leads);
    const backups = await readdir(path.join(root, 'backups'));
    assert.equal(backups.length, 1);
    const backup = JSON.parse(await readFile(path.join(root, 'backups', backups[0], 'manifest.json'), 'utf8'));
    assert.equal(backup.migrations.length, 13);
    await store.run(sql => recordActivity(sql, { method: 'truth.list', tool: 'job_hunt_list_truths', args: [], result: truths }));
    await store.close(); store = undefined;
    store = await JobdeskStore.open(root);
    const live = await createService(store)({ method: 'cockpit.live', args: [] }) as { events: { method: string }[] };
    assert.equal(live.events.length, 1);
    assert.equal(live.events[0].method, 'truth.list');
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
    await rm(previousMigrations, { recursive: true, force: true });
  }
});

test('activity summaries never carry claim or posting text', () => {
  const secret = 'Synthetic private wording that must not be logged';
  const saved = describeCall('workflow.save', [{ packetId: crypto.randomUUID(), inputHash: 'a'.repeat(64),
    result: { recommendation: 'candidate', reasons: [{ text: secret, evidence: secret }], uncertainties: [] } }], {});
  assert.equal(saved.summary, 'Recommendation: candidate. 1 reason, 0 uncertainties.');
  const posting = describeCall('workflow.savePosting', [{ leadId: 'b'.repeat(64), text: secret, sourceNote: secret }], {});
  assert.doesNotMatch(posting.summary, /Synthetic/);
  assert.equal(describeCall('workflow.claims', [{ query: secret }], { claims: [{ text: secret }] }).summary, 'Returned 1 approved claim.');
});
