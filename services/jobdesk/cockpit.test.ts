import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { startJobdesk } from './server';
import { localCall, currentTool } from './mcp-client.mjs';
import { describeCall } from './cockpit';
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
    // Browser calls are not assistant activity.
    assert.equal((await service('cockpit.live')).events.length, 2);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
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
