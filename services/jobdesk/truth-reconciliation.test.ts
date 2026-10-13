import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { JobdeskStore } from './store';
import { createService, initializeService } from './service';
import { reviewedTruthsForDraft, type ReviewClaim } from '../../lib/resume-truth-review';
import type { TruthReconciliationInput } from './truth-reconciliation';

async function fixture() {
  const root = await mkdtemp('/tmp/jobdesk-reconcile-test-');
  const store = await JobdeskStore.open(root);
  await initializeService(store);
  const service = createService(store);
  const call = (request: Parameters<typeof service>[0]) => service(request) as Promise<any>;
  const before = await call({ method: 'truth.list', args: [] }) as ReviewClaim[];
  const [a, b, c] = before;
  const records = [
    { ...a, claim: 'Corrected reviewed synthetic claim.', reviewStatus: 'reviewed' },
    { ...b, reviewStatus: 'rejected' },
    { ...c },
    { id: 'skills.synthetic-codex', claim: 'Codex', sourceNote: 'Synthetic source.',
      reviewStatus: 'reviewed', updatedAt: '2026-09-25T17:29:46.566Z', version: '2026-09-25 17:29:46.566362+00' },
  ];
  const exportJson = JSON.stringify({ claims: records });
  const clean = ({ id, claim, sourceNote, reviewStatus, version }: ReviewClaim) =>
    ({ id, claim, sourceNote, reviewStatus, version });
  const input: TruthReconciliationInput = {
    exportJson, sha256: createHash('sha256').update(exportJson).digest('hex'),
    sourceOrigin: 'https://work.thearcades.me', sourceReference: `file_${'a'.repeat(32)}`,
    expected: [{ id: a.id, record: clean(a) }, { id: b.id, record: clean(b) },
      { id: 'skills.synthetic-codex', record: null }],
  };
  const reconcile = (value = input) => call({ method: 'truth.reconcileHosted', args: [value] });
  const list = () => call({ method: 'truth.list', args: [] }) as Promise<ReviewClaim[]>;
  const versions = (id: string) => call({ method: 'truth.versions', args: [id] });
  const cleanup = async () => { await store.close(); await rm(root, { recursive: true, force: true }); };
  return { store, call, before, records, input, reconcile, list, versions, cleanup, a, b, c };
}

test('recovery preserves decisions, wording, provenance, history and unrelated newer claims; retries are idempotent', async () => {
  const f = await fixture();
  try {
    const oldVersions = await f.versions(f.a.id);
    await f.call({ method: 'truth.addProject', args: [{ slug: 'preserved-project',
      claim: 'Built a synthetic unrelated project.', sourceNote: 'Synthetic local source.' }] });
    await f.call({ method: 'truth.review', args: [{ changes: [{ id: f.c.id,
      expectedVersion: f.c.version, reviewStatus: 'reviewed', claim: 'Newer unrelated local wording.' }] }] });
    const immediatelyBefore = await f.list();
    const result = await f.reconcile();
    assert.equal(result.changed.length, 2);
    assert.equal(result.added.length, 1);
    const after = await f.list();
    assert.equal(after.length, immediatelyBefore.length + 1);
    const reviewed = after.find((row) => row.id === f.a.id)!;
    assert.equal(reviewed.claim, f.records[0].claim);
    assert.equal(reviewed.reviewStatus, 'reviewed');
    assert.ok(reviewed.sourceNote.startsWith(f.records[0].sourceNote + '\n'));
    assert.ok(reviewed.sourceNote.includes(f.input.sha256));
    const codex = after.find((row) => row.id === 'skills.synthetic-codex')!;
    assert.ok(codex.sourceNote.includes('2026-09-25 17:29:46.566362+00'));
    assert.notEqual(codex.version, f.records[3].version);
    assert.deepEqual((await f.versions(f.a.id)).slice(1), oldVersions);
    assert.equal((await f.versions(codex.id)).length, 1);
    const untouched = (rows: ReviewClaim[]) => rows.filter((row) => ![f.a.id, f.b.id, codex.id].includes(row.id));
    assert.deepEqual(untouched(after), untouched(immediatelyBefore));
    assert.ok(!reviewedTruthsForDraft(after).some((row) => row.id === f.b.id || row.id === 'project.preserved-project'));
    const histories = await Promise.all(after.map((row) => f.versions(row.id)));
    const retry = await f.reconcile();
    assert.equal(retry.changed.length, 0);
    assert.equal(retry.added.length, 0);
    assert.equal(retry.alreadyApplied.length, 3);
    assert.deepEqual(await f.list(), after);
    assert.deepEqual(await Promise.all(after.map((row) => f.versions(row.id))), histories);
  } finally { await f.cleanup(); }
});

test('stale local versions and conflicting missing IDs reject the whole import without changing other decisions', async () => {
  const f = await fixture();
  try {
    await f.call({ method: 'truth.review', args: [{ changes: [{ id: f.a.id,
      expectedVersion: f.a.version, reviewStatus: 'reviewed', claim: 'Newer protected edit.' }] }] });
    const protectedRows = await f.list();
    await assert.rejects(f.reconcile(), /No records changed/);
    assert.deepEqual(await f.list(), protectedRows);
    const fresh = structuredClone(f.input);
    const changed = protectedRows.find((row) => row.id === f.a.id)!;
    fresh.expected[0].record = { id: changed.id, claim: changed.claim, sourceNote: changed.sourceNote,
      reviewStatus: changed.reviewStatus, version: changed.version };
    await f.store.sql`INSERT INTO resume_truth_claims(id,claim,source_note,review_status)
      VALUES ('skills.synthetic-codex','Conflicting local record.','Synthetic.','unreviewed')`;
    const conflicted = await f.list();
    await assert.rejects(f.reconcile(fresh), /No records changed/);
    assert.deepEqual(await f.list(), conflicted);
  } finally { await f.cleanup(); }
});

test('invalid export hash, duplicate IDs and injected review decisions write nothing', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.reconcile({ ...f.input, sha256: '0'.repeat(64) }), /checksum/);
    const exportJson = JSON.stringify({ claims: [...f.records, f.records[0]] });
    await assert.rejects(f.reconcile({ ...f.input, exportJson,
      sha256: createHash('sha256').update(exportJson).digest('hex') }), /unique/);
    await assert.rejects(f.call({ method: 'truth.reconcileHosted', args: [{ ...f.input, approveAll: true }] }));
    await assert.rejects(f.reconcile({ ...f.input, expected: [...f.input.expected,
      { id: f.c.id, record: null }] }), /exactly/);
    assert.deepEqual(await f.list(), f.before);
  } finally { await f.cleanup(); }
});

test('history failure rolls back all earlier writes; supported backup restores exact pre-import claims', async () => {
  const f = await fixture();
  const restoredRoot = await mkdtemp('/tmp/jobdesk-reconcile-restore-');
  let restored: JobdeskStore | undefined;
  try {
    const backup = await f.call({ method: 'backup', args: [] });
    await f.store.db.exec(`CREATE FUNCTION reject_import_history() RETURNS trigger AS $$
      BEGIN IF NEW.claim_id='skills.synthetic-codex' THEN RAISE EXCEPTION 'Synthetic failure'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_history BEFORE INSERT ON resume_truth_versions
      FOR EACH ROW EXECUTE FUNCTION reject_import_history();`);
    await assert.rejects(f.reconcile(), /Synthetic failure/);
    assert.deepEqual(await f.list(), f.before);
    assert.equal((await f.versions(f.a.id)).length, 1);
    assert.deepEqual(await f.versions('skills.synthetic-codex'), []);
    await f.store.db.exec('DROP TRIGGER reject_history ON resume_truth_versions;');
    await f.reconcile();
    const bytes = await readFile(`${backup.directory}/database.tar.gz`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), backup.manifest.sha256);
    restored = await JobdeskStore.open(restoredRoot, undefined, new Blob([new Uint8Array(bytes)]));
    const restoredCall = createService(restored);
    assert.deepEqual(await restoredCall({ method: 'truth.list', args: [] }), f.before);
    assert.equal((await restoredCall({ method: 'truth.versions', args: [f.a.id] }) as unknown[]).length, 1);
  } finally {
    await restored?.close(); await rm(restoredRoot, { recursive: true, force: true }); await f.cleanup();
  }
});
