import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { JobdeskStore } from './store';
import { createService, initializeService } from './service';
import { tempRoot } from '../../tests/fixtures/temp-root';

test('project creation preserves existing truths, validates input, and records only one unreviewed version', async () => {
  const root = await tempRoot('jobdesk-project-test-');
  const store = await JobdeskStore.open(root);
  try {
    await initializeService(store);
    const service = createService(store);
    const call = (request: Parameters<typeof service>[0]) => service(request) as Promise<any>;
    const before = await call({ method: 'truth.list', args: [] });
    const input = { slug: 'test-project', claim: 'Built a synthetic test project.', sourceNote: 'Synthetic local source.' };
    const add = (value: unknown) => call({ method: 'truth.addProject', args: [value] });
    await assert.rejects(add({ ...input, reviewStatus: 'reviewed' }));
    await assert.rejects(add({ ...input, claim: ' ' }));
    await assert.rejects(add({ ...input, sourceNote: ' ' }));
    await assert.rejects(add({ ...input, slug: '../profile.name' }));
    const added = await add(input);
    assert.equal(added.created, true);
    assert.equal(added.claim.id, 'project.test-project');
    assert.equal(added.claim.reviewStatus, 'unreviewed');
    assert.ok(added.claim.version);
    const versions = () => call({ method: 'truth.versions', args: ['project.test-project'] });
    assert.equal((await versions()).length, 1);
    assert.equal((await versions())[0].reviewStatus, 'unreviewed');
    assert.equal((await add(input)).created, false);
    await assert.rejects(add({ ...input, claim: 'Changed wording.' }), /already exists/);
    await assert.rejects(add({ ...input, sourceNote: 'Changed provenance.' }), /already exists/);
    await assert.rejects(add({ ...input, slug: 'another-id', claim: ' built  a synthetic TEST project. ' }), /already exists/);
    await assert.rejects(add({ ...input, slug: 'existing-career-copy', claim: before[0].claim }), /already exists/);
    const after = await call({ method: 'truth.list', args: [] });
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(after.filter((row: any) => row.id !== 'project.test-project'), before);
    assert.equal((await versions()).length, 1);
    // A retry after an independently reviewed record must preserve that decision.
    await call({ method: 'truth.review', args: [{ changes: [{ id: added.claim.id,
      expectedVersion: added.claim.version, reviewStatus: 'reviewed' }] }] });
    const retried = await add(input);
    assert.equal(retried.created, false);
    assert.equal(retried.claim.reviewStatus, 'reviewed');
    assert.equal((await versions()).length, 2);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('failed project history insertion rolls back the truth insertion', async () => {
  const root = await tempRoot('jobdesk-project-rollback-');
  const store = await JobdeskStore.open(root);
  try {
    await initializeService(store);
    const service = createService(store);
    const call = (request: Parameters<typeof service>[0]) => service(request) as Promise<any>;
    const before = await call({ method: 'truth.list', args: [] });
    await store.db.exec(`CREATE FUNCTION reject_project_history() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'Synthetic history write failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_history BEFORE INSERT ON resume_truth_versions
      FOR EACH ROW EXECUTE FUNCTION reject_project_history();`);
    await assert.rejects(call({ method: 'truth.addProject', args: [{ slug: 'rollback-fixture',
      claim: 'Built a rollback fixture.', sourceNote: 'Synthetic.' }] }), /Synthetic/);
    assert.deepEqual(await call({ method: 'truth.list', args: [] }), before);
    assert.deepEqual(await call({ method: 'truth.versions', args: ['project.rollback-fixture'] }), []);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
