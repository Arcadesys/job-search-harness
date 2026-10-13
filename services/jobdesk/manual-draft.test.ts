import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { JobdeskStore } from './store';
import { createService, initializeService } from './service';
import { leadIdForUrl } from '../../lib/job-discovery';
import { tempRoot } from '../../tests/fixtures/temp-root';
import { loadSample } from '../../tests/fixtures/sample-resume';

test('manual materials persist without a provider call and retain approval, truth and duplicate guards', async () => {
  const root = await tempRoot('jobdesk-manual-');
  const store = await JobdeskStore.open(root);
  const oldFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('No provider call permitted in this fixture.'); };
  try {
    await initializeService(store);
    await loadSample(store);
    const service = createService(store);
    const call = (method: any, args: any[] = []) => service({ method, args }) as Promise<any>;
    const truths = await call('truth.list');
    const truth = truths[0];
    const url = 'https://example.test/jobs/manual', leadId = leadIdForUrl(url);
    const input = { leadId, resumeVariant: 'Human-reviewed synthetic résumé.', outreach: 'Exact synthetic answers.', claimIds: [truth.id] };
    await assert.rejects(call('draft.saveManual', [input]), /verified original posting/);
    await call('leads.add', [{ url, title: 'Synthetic manual fixture' }]);
    await call('leads.update', [{ id: leadId, decision: 'keep' }]);
    await assert.rejects(call('draft.saveManual', [input]), /verified original posting/);
    await call('draft.posting', [leadId, 'Synthetic posting; no employer contacted. '.repeat(8), 'Synthetic original source.']);
    await assert.rejects(call('draft.saveManual', [input]), /exist and be reviewed/);
    await call('truth.review', [{ changes: [{ id: truth.id, expectedVersion: truth.version, reviewStatus: 'reviewed' }] }]);
    await assert.rejects(call('draft.saveManual', [{ ...input, claimIds: ['nonexistent.truth'] }]), /exist and be reviewed/);
    const saved = await call('draft.saveManual', [input]);
    assert.equal(saved.reviewStatus, 'review_required');
    const read = await call('draft.read', [leadId]);
    assert.equal(read.history.draft.resumeVariant, input.resumeVariant);
    assert.equal(read.history.draft.outreach, input.outreach);
    const batch = await call('batches.create', [[leadId]]);
    const itemId = (await call('batches.items', [batch.id])).items[0].itemId;
    const lease = await call('items.claim', [{ itemId, workerId: 'manual-fixture' }]);
    const leaseInput = { itemId, workerId: lease.workerId, generation: lease.generation };
    const binding = (await call('items.read', [itemId])).item;
    await assert.rejects(call('submission.begin', [{ ...leaseInput, draftVersion: binding.draftVersion, draftHash: binding.draftHash }]),
      (error: any) => error.code === 'STALE_DRAFT');
    await call('draft.approve', [leadId, saved.version]);
    const edited = await call('draft.saveManual', [{ ...input, outreach: 'Revised exact answers.' }]);
    await assert.rejects(call('draft.approve', [leadId, saved.version]), /Draft changed/);
    await call('draft.approve', [leadId, edited.version]);
    await assert.rejects(call('submission.begin', [{ ...leaseInput, draftVersion: binding.draftVersion, draftHash: binding.draftHash }]),
      (error: any) => error.code === 'STALE_DRAFT');
    const currentTruth = (await call('truth.list')).find((c: any) => c.id === truth.id);
    await call('truth.review', [{ changes: [{ id: truth.id, expectedVersion: currentTruth.version, claim: 'Changed synthetic fact.', reviewStatus: 'reviewed' }] }]);
    const stale = (await call('items.read', [itemId])).item;
    await assert.rejects(call('submission.begin', [{ ...leaseInput, draftVersion: stale.draftVersion, draftHash: stale.draftHash }]),
      (error: any) => error.code === 'STALE_DRAFT');
    const refreshed = await call('draft.saveManual', [input]);
    await call('draft.approve', [leadId, refreshed.version]);
    const ready = (await call('items.read', [itemId])).item;
    const attempt = await call('submission.begin', [{ ...leaseInput, draftVersion: ready.draftVersion, draftHash: ready.draftHash }]);
    await assert.rejects(call('draft.saveManual', [input]), /reconciliation/);
    await call('submission.uncertain', [attempt.id, 'Synthetic uncertainty.']);
    await assert.rejects(call('draft.saveManual', [input]), /reconciliation/);
    await call('submission.record', [{ itemId, idempotencyKey: 'manual-fixture-receipt', confirmation: 'Synthetic receipt; no employer contacted.' }]);
    await assert.rejects(call('draft.saveManual', [input]), /already applied/);
    const otherUrl = 'https://example.test/jobs/already-applied', otherId = leadIdForUrl(otherUrl);
    await call('leads.add', [{ url: otherUrl, title: 'Synthetic applied fixture' }]);
    await call('draft.posting', [otherId, 'Synthetic posting; no employer contacted. '.repeat(8), 'Synthetic original source.']);
    await call('leads.update', [{ id: otherId, decision: 'pass', stage: 'applied', verification: 'verified' }]);
    await assert.rejects(call('draft.saveManual', [{ ...input, leadId: otherId }]), /already applied/);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = oldFetch;
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
