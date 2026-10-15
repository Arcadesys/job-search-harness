import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../services/jobdesk/migrate';
import { JobdeskError } from '../services/jobdesk/errors';
import { parameterizedSql, type Sql } from './job-storage';
import { type SearchBriefProposal } from './search-brief';
import { activateBrief, appendBriefMessage, cancelBriefDraft, readActiveSearchBrief,
  readBriefState, saveBriefProposal } from './search-brief-store';

const message = { id: 'user-message-1', text: "I'd prefer remote work; hybrid is also fine. Keep my exact wording." };
const proposal = (kind: 'preference' | 'hard_requirement' = 'preference'): SearchBriefProposal => ({
  criteria: [{ id: 'mode', topic: 'work_mode', kind, state: 'answered',
    parameter: { field: 'work_mode', modes: ['remote'] },
    sources: [{ messageId: message.id, quote: "I'd prefer remote work" }] }],
});
const rejected = (pattern: RegExp) => (error: unknown) => {
  assert.ok(error instanceof JobdeskError);
  assert.equal(error.code, 'WORKFLOW_REJECTED');
  assert.match(error.message, pattern);
  return true;
};
async function fixture(t: TestContext) {
  // No store singleton, on-disk data directory, provider, or network is involved.
  const db = new PGlite();
  t.after(() => db.close());
  await migrate(db);
  const sql = parameterizedSql(db);
  const write = <T>(operation: (sql: Sql) => Promise<T>) => db.transaction((tx) => operation(parameterizedSql(tx)));
  return { db, sql, write };
}
async function seed(t: TestContext) {
  const f = await fixture(t);
  await f.write((sql) => appendBriefMessage(message, sql));
  const state = await f.write((sql) => saveBriefProposal({ proposal: proposal(), expectedDraftHash: null }, sql));
  assert.ok(state.draft);
  assert.ok(state.review);
  return { ...f, state, hash: state.review.contentHash };
}

test('message retries are idempotent and conflicting text cannot overwrite user provenance', async (t) => {
  const { sql, write } = await fixture(t);
  assert.deepEqual(await readBriefState(sql), { draft: null, review: null, active: null, messages: [] });
  assert.deepEqual(await write((sql) => appendBriefMessage(message, sql)), { id: message.id, reused: false });
  assert.deepEqual(await write((sql) => appendBriefMessage(message, sql)), { id: message.id, reused: true });
  await assert.rejects(write((sql) => appendBriefMessage({ ...message, text: 'Remote is essential.' }, sql)), rejected(/different text/));
  assert.deepEqual((await readBriefState(sql)).messages, [message]);
});

test('proposal retries reuse the stored version and retain exact quoted user provenance', async (t) => {
  const { sql, write, state, hash } = await seed(t);
  const retry = await write((sql) => saveBriefProposal({ proposal: proposal(), expectedDraftHash: null }, sql));
  assert.equal(retry.reused, true);
  assert.deepEqual(retry.draft, state.draft);
  assert.equal(retry.review?.contentHash, hash);
  assert.deepEqual(retry.review?.summary[0].sources, proposal().criteria[0].sources);
  assert.deepEqual(retry.messages, [message]);
  assert.deepEqual(await sql`SELECT version FROM job_search_brief_versions`, [{ version: 1 }]);
  assert.equal(await readActiveSearchBrief(sql), null);
});

test('proposals must quote an existing stored user message exactly', async (t) => {
  const { sql, write } = await fixture(t);
  await write((sql) => appendBriefMessage(message, sql));
  for (const source of [
    { messageId: 'unrecorded-message', quote: "I'd prefer remote work" },
    { messageId: message.id, quote: 'Remote work is mandatory' },
    { messageId: message.id, quote: "i'd prefer remote work" },
  ]) {
    const invalid = proposal();
    invalid.criteria[0].sources = [source];
    await assert.rejects(write((sql) => saveBriefProposal({ proposal: invalid, expectedDraftHash: null }, sql)), /exact quote from a user message/);
  }
  assert.deepEqual(await sql`SELECT version FROM job_search_brief_versions`, []);
  assert.equal((await readBriefState(sql)).draft, null);
  assert.deepEqual((await readBriefState(sql)).messages, [message]);
});

test('stale draft proposals, reviews and cancellations reject without modifying current state', async (t) => {
  const { sql, write, hash } = await seed(t);
  await assert.rejects(write((sql) => saveBriefProposal({ proposal: proposal('hard_requirement'), expectedDraftHash: null }, sql)), rejected(/draft changed/));
  const revised = await write((sql) => saveBriefProposal({ proposal: proposal('hard_requirement'), expectedDraftHash: hash }, sql));
  assert.equal(revised.draft?.version, 2);
  await assert.rejects(write((sql) => activateBrief({ reviewedHash: hash, expectedActiveHash: null }, sql)), rejected(/draft changed since review/));
  await assert.rejects(write((sql) => cancelBriefDraft({ expectedDraftHash: hash }, sql)), rejected(/draft changed/));
  await assert.rejects(write((sql) => saveBriefProposal({ proposal: proposal(), expectedDraftHash: hash }, sql)), rejected(/draft changed/));
  assert.deepEqual(await readBriefState(sql), { draft: revised.draft, review: revised.review, active: null, messages: revised.messages });
});

test('approval retries preserve the original snapshot and reject a stale active hash', async (t) => {
  const { sql, write, hash } = await seed(t);
  const approved = await write((sql) => activateBrief({ reviewedHash: hash, expectedActiveHash: null }, sql));
  assert.equal(approved.reused, false);
  const snapshots = await sql`SELECT approved_snapshot FROM job_search_brief_versions WHERE version=1`;
  assert.equal(snapshots[0].approved_snapshot.approval.actor, 'user');
  assert.equal(snapshots[0].approved_snapshot.approval.reviewedHash, hash);
  const revision = await write((sql) => saveBriefProposal({ proposal: proposal('hard_requirement'), expectedDraftHash: null }, sql));
  assert.ok(revision.review);
  const retry = await write((sql) => activateBrief({ reviewedHash: hash, expectedActiveHash: null }, sql));
  assert.equal(retry.reused, true);
  assert.deepEqual(retry.active, approved.active);
  assert.deepEqual(await sql`SELECT approved_snapshot FROM job_search_brief_versions WHERE version=1`, snapshots);
  assert.deepEqual((await readBriefState(sql)).draft, revision.draft);
  await assert.rejects(write((sql) => activateBrief({ reviewedHash: revision.review!.contentHash, expectedActiveHash: null }, sql)), rejected(/active brief changed/));
  assert.deepEqual(await readActiveSearchBrief(sql), approved.active);
  const next = await write((sql) => activateBrief({ reviewedHash: revision.review!.contentHash, expectedActiveHash: hash }, sql));
  assert.equal(next.active.identity.version, 2);
  assert.equal(next.active.hardRequirements.length, 1);
  assert.equal((await readBriefState(sql)).draft, null);
});

test('cancel preserves the active brief and version numbers remain monotonic across cancellation and approval', async (t) => {
  const { sql, write, hash } = await seed(t);
  const first = await write((sql) => activateBrief({ reviewedHash: hash, expectedActiveHash: null }, sql));
  const second = await write((sql) => saveBriefProposal({ proposal: proposal('hard_requirement'), expectedDraftHash: null }, sql));
  assert.equal(second.draft?.version, 2);
  assert.ok(second.review);
  const cancel = { expectedDraftHash: second.review.contentHash };
  assert.deepEqual(await write((sql) => cancelBriefDraft(cancel, sql)), { cancelled: true, reused: false });
  assert.deepEqual(await write((sql) => cancelBriefDraft(cancel, sql)), { cancelled: false, reused: true });
  assert.deepEqual(await readActiveSearchBrief(sql), first.active);
  assert.equal((await readBriefState(sql)).draft, null);
  const third = await write((sql) => saveBriefProposal({ proposal: proposal(), expectedDraftHash: null }, sql));
  assert.equal(third.draft?.version, 3);
  assert.ok(third.review);
  await write((sql) => activateBrief({ reviewedHash: third.review!.contentHash, expectedActiveHash: hash }, sql));
  const fourth = await write((sql) => saveBriefProposal({ proposal: proposal('hard_requirement'), expectedDraftHash: null }, sql));
  assert.equal(fourth.draft?.version, 4);
  assert.deepEqual(await sql`SELECT version FROM job_search_brief_versions ORDER BY version`, [1, 2, 3, 4].map((version) => ({ version })));
});

test('messages, active approval and pending revision survive an in-memory database export and reload', async (t) => {
  const { db, sql, write, hash } = await seed(t);
  await write((sql) => activateBrief({ reviewedHash: hash, expectedActiveHash: null }, sql));
  await write((sql) => saveBriefProposal({ proposal: proposal('hard_requirement'), expectedDraftHash: null }, sql));
  const before = await readBriefState(sql);
  const snapshots = await sql`SELECT version,approved_snapshot FROM job_search_brief_versions ORDER BY version`;
  const restored = new PGlite({ loadDataDir: await db.dumpDataDir() });
  t.after(() => restored.close());
  await migrate(restored);
  const restoredSql = parameterizedSql(restored);
  assert.deepEqual(await readBriefState(restoredSql), before);
  assert.deepEqual(await restoredSql`SELECT version,approved_snapshot FROM job_search_brief_versions ORDER BY version`, snapshots);
});

test('interpreted criteria exceeding 4,000 UTF-8 bytes reject without persisting a draft or version', async (t) => {
  const { sql, write } = await fixture(t);
  await write((sql) => appendBriefMessage(message, sql));
  for (const value of ['a'.repeat(4100), '界'.repeat(1400)]) {
    const oversized: SearchBriefProposal = { criteria: [{
      id: 'role', topic: 'role', kind: 'preference', state: 'answered',
      parameter: { field: 'role', value },
      sources: [{ messageId: message.id, quote: "I'd prefer remote work" }],
    }] };
    assert.ok(JSON.stringify(oversized).length < 24000, 'The proposal remains below the separate character cap.');
    if (value.startsWith('界')) {
      assert.ok(JSON.stringify(oversized).length < 4000, 'Multibyte payload must reject based on bytes, not characters.');
    }
    await assert.rejects(
      write((sql) => saveBriefProposal({ proposal: oversized, expectedDraftHash: null }, sql)),
      rejected(/4,000-byte workflow budget/),
    );
    assert.deepEqual(await sql`SELECT version FROM job_search_brief_versions`, []);
    assert.deepEqual(await readBriefState(sql), { draft: null, review: null, active: null, messages: [message] });
  }
});
