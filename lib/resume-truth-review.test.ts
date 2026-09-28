import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { sqlAdapter } from '../tests/fixtures/truth-database';
import { handleTruthReview } from './resume-truth-http';
import { baselineResumeClaims, listResumeTruth, listResumeTruthVersions, reviewResumeTruth, saveResumeTruth, seedResumeTruth } from './resume-truth';
import { reviewedTruthsForDraft, editedStatus, groupTruths, relatedTruthPairs, reviewBatchSchema, type ReviewClaim } from './resume-truth-review';

const fixture = (): ReviewClaim[] => baselineResumeClaims().map((c) => ({ ...c, version: 'v1' }));

test('every imported fact is grouped once; role basics and related achievements stay together', () => {
  const claims = fixture(); const groups = groupTruths(claims);
  assert.equal(groups.flatMap((g) => g.claims).length, claims.length);
  const arity = groups.find((g) => g.id === 'experience.3')!;
  assert.ok(arity.claims.some((c) => c.id === 'experience.3.dates'));
  assert.ok(arity.claims.some((c) => c.id === 'accomplishment.6'));
  assert.equal(groups[0].section, 'Personal details');
});

test('related wording uses guarded known relationships, not positional bullet IDs', () => {
  const claims = fixture();
  assert.equal(relatedTruthPairs(claims).size, 8);
  const adoption = claims.find((c) => c.claim.includes('adoption was still climbing'))!;
  const summary = claims.find((c) => c.id === 'accomplishment.1')!;
  assert.equal(relatedTruthPairs(claims).get(adoption.id), summary.id);
  summary.claim = 'Codex';
  assert.ok(![...relatedTruthPairs(claims).values()].includes(summary.id));
  assert.equal(groupTruths(claims).find((g) => g.claims.some((c) => c.id === summary.id))!.section, 'Other claims');
});

test('batch validation rejects empty, duplicate, versionless, and invalid updates', () => {
  const change = { id: 'a', expectedVersion: 'v1', reviewStatus: 'reviewed' };
  for (const body of [{ changes: [] }, { changes: [change, change] }, { changes: [{ ...change, expectedVersion: '' }] }, { changes: [{ ...change, claim: '  ' }] }, { changes: [{ ...change, reviewStatus: 'approved' }] }]) assert.equal(reviewBatchSchema.safeParse(body).success, false);
});

test('changed approved wording or source needs renewed approval', () => {
  const original = { ...fixture()[0], reviewStatus: 'reviewed' as const };
  assert.equal(editedStatus(original, original), 'reviewed');
  assert.equal(editedStatus(original, { ...original, claim: 'Corrected' }), 'unreviewed');
  assert.equal(editedStatus(original, { ...original, sourceNote: 'New source' }), 'unreviewed');
});

test('real SQL: exact batches, stale and missing records, independent copies, undo history and restart persistence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'truth-review-db-'));
  let db = new PGlite(directory);
  try {
    await db.exec(await readFile(new URL('../db/migrations/0001_resume_truth.sql', import.meta.url), 'utf8'));
    let sql = sqlAdapter(db); await seedResumeTruth(sql);
    const initial = await listResumeTruth(sql);
    const chosen = ['experience.3.title', 'experience.3.dates'];
    const changes = initial.filter((c) => chosen.includes(c.id)).map((c) => ({ id: c.id, expectedVersion: c.version, reviewStatus: 'reviewed' as const }));
    const approved = await reviewResumeTruth(changes, sql);
    assert.deepEqual(approved.conflicts, []); assert.equal(approved.claims.length, 2);
    assert.deepEqual((await listResumeTruth(sql)).filter((c) => c.reviewStatus === 'reviewed').map((c) => c.id).sort(), chosen.sort());
    assert.equal((await listResumeTruthVersions(chosen[0], sql)).length, 2);
    const untouched = initial.find((c) => c.id === 'experience.3.claim.1')!;
    const conflict = await reviewResumeTruth([changes[0], { id: untouched.id, expectedVersion: untouched.version, reviewStatus: 'reviewed' }], sql);
    assert.deepEqual(conflict.conflicts, [changes[0].id]); assert.equal(conflict.claims.length, 0);
    assert.equal((await listResumeTruthVersions(untouched.id, sql)).length, 1);
    const missing = await reviewResumeTruth([{ id: 'missing', expectedVersion: 'v1', reviewStatus: 'reviewed' }, { id: untouched.id, expectedVersion: untouched.version, reviewStatus: 'reviewed' }], sql);
    assert.deepEqual(missing.conflicts, ['missing']); assert.equal(missing.claims.length, 0);
    const edited = await reviewResumeTruth([{ id: untouched.id, expectedVersion: untouched.version, reviewStatus: 'reviewed', claim: 'Corrected planning claim', sourceNote: 'User confirmed original evidence' }], sql);
    assert.equal(edited.claims[0].claim, 'Corrected planning claim');
    assert.equal((await listResumeTruth(sql)).find((c) => c.id === 'accomplishment.6')!.reviewStatus, 'unreviewed');
    const undone = await reviewResumeTruth(approved.claims.map((c) => ({ id: c.id, expectedVersion: c.version, reviewStatus: 'unreviewed' })), sql);
    assert.equal(undone.claims.length, 2);
    assert.equal((await listResumeTruthVersions(chosen[0], sql)).length, 3);
    // An existing single-record caller must also invalidate a batch's token.
    await saveResumeTruth({ ...edited.claims[0], claim: 'Legacy caller correction' }, sql);
    assert.equal((await reviewResumeTruth([{ id: untouched.id, expectedVersion: edited.claims[0].version, reviewStatus: 'unreviewed' }], sql)).conflicts.length, 1);
    await db.close(); db = new PGlite(directory); sql = sqlAdapter(db);
    const persisted = await listResumeTruth(sql);
    assert.equal(persisted.find((c) => c.id === untouched.id)!.claim, 'Legacy caller correction');
    assert.deepEqual(reviewedTruthsForDraft(persisted).map((c) => c.id), [untouched.id]);
    assert.equal(reviewedTruthsForDraft(persisted)[0].sourceNote, 'User confirmed original evidence');
    assert.equal(persisted.find((c) => c.id === chosen[0])!.reviewStatus, 'unreviewed');
    assert.equal((await listResumeTruthVersions(chosen[0], sql)).length, 3);
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
});


test('HTTP review authorizes before touching storage, validates input, and retains private headers', async () => {
  let reads = 0;
  const dependencies = { authorize: async (): Promise<string | null> => null, save: async () => { reads++; return { claims: [], conflicts: [] }; }, list: async () => { reads++; return []; } };
  const request = (body: unknown) => new Request('http://localhost/api/jobs/resume-truth', { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await handleTruthReview(request({}), dependencies)).status, 401);
  assert.equal(reads, 0);
  dependencies.authorize = async () => 'test-account';
  const invalid = await handleTruthReview(request({ changes: [] }), dependencies);
  assert.equal(invalid.status, 400); assert.equal(reads, 0);
  assert.equal(invalid.headers.get('Cache-Control'), 'private, no-store');
  const valid = await handleTruthReview(request({ changes: [{ id: 'a', expectedVersion: 'v', reviewStatus: 'reviewed' }] }), dependencies);
  assert.equal(valid.status, 200);
  assert.deepEqual((await valid.json()).progress, { reviewed: 0, unreviewed: 0, rejected: 0 });
});
