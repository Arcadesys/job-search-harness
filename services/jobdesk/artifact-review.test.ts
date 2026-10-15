import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { parameterizedSql } from '../../lib/job-storage';
import { leadIdForUrl } from '../../lib/job-discovery';
import { payloadBytes } from '../../lib/workflow-hash';
import { TEMPLATE_VERSION } from '../../lib/job-workflow';
import { loadSample } from '../../tests/fixtures/sample-resume';
import { migrate } from './migrate';
import { createService, initializeService } from './service';
import { JobdeskStore } from './store';

const POSTING = 'Manage cross-functional programs, delivery and analytics enablement. '.repeat(15);
async function setup() {
  const root = await mkdtemp(path.join(process.cwd(), '.artifact-review-test-'));
  const db = await PGlite.create();
  await migrate(db);
  const sql = parameterizedSql(db);
  // Exercise the real queue, transactions, renderer and disk artifacts without
  // changing the production private-root ownership checks for sandbox tests.
  const store = Object.assign(Object.create(JobdeskStore.prototype), {
    root, db, sql, tail: Promise.resolve(), closing: false,
  }) as JobdeskStore;
  await mkdir(path.join(root, 'artifacts'));
  await initializeService(store);
  await loadSample(store);
  await store.run((sql) => sql`UPDATE resume_truth_claims SET review_status='reviewed'`);
  const call = createService(store), trusted = createService(store, { trustedUserActions: true });
  return { root, db, store, sql, call, trusted, close: async () => { await db.close(); await rm(root, { recursive: true, force: true }); } };
}
type Call = ReturnType<typeof createService>;
const rpc = (call: Call, method: string, ...args: unknown[]): Promise<any> => call({ method, args });
async function build(call: Call, suffix = 'one', posting = POSTING, claimIds = ['experience.1.claim.1']) {
  const url = `https://example.test/jobs/${suffix}`, leadId = leadIdForUrl(url);
  await rpc(call, 'leads.add', { url, title: 'Delivery Manager', organization: 'Example Employer' });
  await rpc(call, 'draft.posting', leadId, posting, 'User verified this fictional original posting.');
  const assessment = await rpc(call, 'workflow.packet', { leadId, stage: 'assessment' });
  await rpc(call, 'workflow.save', { packetId: assessment.id, inputHash: assessment.inputHash,
    result: { recommendation: 'candidate', reasons: [{ text: 'Relevant delivery work.', evidence: 'cross-functional programs' }], uncertainties: [], claimIds: ['experience.1.claim.1'] } });
  const selection = await rpc(call, 'workflow.packet', { leadId, stage: 'selection' });
  await rpc(call, 'workflow.save', { packetId: selection.id, inputHash: selection.inputHash,
    result: { template: TEMPLATE_VERSION, sections: [{ kind: 'experience', claimIds }], outreach: false, unresolved: [] } });
  const materials = await rpc(call, 'workflow.build', { leadId });
  assert.equal(materials.state, 'current');
  return { leadId, materials };
}
const review = (packet: any, findings: unknown[] = []) => ({ schemaVersion: 1, binding: packet.binding,
  rubricVersion: 'recruiter-live-1', reviewer: 'Offline fixture reviewer', findings });
const save = (call: Call, packet: any, result: unknown) => rpc(call, 'recruiter.save', { packetId: packet.id, inputHash: packet.inputHash, result });

test('actual PDF evaluation is saved, idempotent and cannot approve; recruiter results are immutable', async () => {
  const fixture = await setup(); const { call, sql } = fixture;
  try {
    const { leadId, materials } = await build(call);
    await assert.rejects(rpc(call, 'recruiter.packet', { leadId }), /passing deterministic evaluation/);
    await rpc(call, 'workflow.review', { id: materials.id, inputHash: materials.inputHash, passed: true, note: 'Synthetic visual inspection for approval-gate testing.' });
    await assert.rejects(rpc(call, 'draft.approve', leadId, materials.draftVersion), /passing deterministic evaluation/);
    const evaluated = await rpc(call, 'evaluation.run', { leadId });
    assert.equal(evaluated.state, 'complete'); assert.equal(evaluated.report.passed, true);
    assert.equal(evaluated.report.approvalGranted, false);
    const [stored] = await sql`SELECT * FROM job_work_stages WHERE id=${evaluated.id}`;
    assert.equal(stored.attempts, 1); assert.equal(stored.result.report.passed, true);
    assert.match(stored.result.extractedText, /Jordan Rivera/);
    const repeated = await rpc(call, 'evaluation.run', { leadId, retry: true });
    assert.equal(repeated.reused, true);
    assert.deepEqual((await sql`SELECT * FROM job_work_stages WHERE id=${evaluated.id}`)[0], stored);
    const packet = await rpc(call, 'recruiter.packet', { leadId });
    assert.equal(packet.binding.artifactId, materials.artifacts.find((a: any) => a.kind === 'resume').id);
    assert.equal(packet.approvalGranted, false); assert.equal(packet.advisoryOnly, true);
    const result = review(packet, [{ category: 'missing_evidence', concern: 'A human should assess the delivery evidence.',
      claimIds: [], resumeQuote: '', postingQuote: 'cross-functional programs' }]);
    const saved = await save(call, packet, result);
    assert.equal(saved.state, 'complete'); assert.equal(saved.review.approvalGranted, false);
    assert.equal((await save(call, packet, result)).reused, true);
    const persisted = await rpc(call, 'reviews.read', { leadId });
    assert.deepEqual(persisted.evaluation.report, evaluated.report);
    assert.deepEqual(persisted.recruiter.review, saved.review);
    assert.equal(persisted.approvalGranted, false);
    assert.equal('extractedText' in persisted.evaluation, false, 'report reads do not expose the full saved PDF text');
    await assert.rejects(save(call, packet, review(packet)), /immutable/);
    assert.equal((await sql`SELECT attempts FROM job_work_stages WHERE id=${packet.id}`)[0].attempts, 1);
    assert.equal((await sql`SELECT review_status FROM job_application_drafts WHERE lead_id=${leadId}`)[0].review_status, 'review_required');
    assert.equal((await sql`SELECT count(*)::int AS n FROM jobdesk_artifacts WHERE lead_id=${leadId} AND approval_state='approved'`)[0].n, 0);
  } finally { await fixture.close(); }
});

test('recruiter citation failures consume at most two attempts and cannot poison another job', async () => {
  const fixture = await setup(); const { call, sql } = fixture;
  try {
    const first = await build(call), second = await build(call, 'two');
    await rpc(call, 'evaluation.run', { leadId: first.leadId });
    await assert.rejects(rpc(call, 'recruiter.packet', { leadId: second.leadId }), /passing deterministic evaluation/);
    await rpc(call, 'evaluation.run', { leadId: second.leadId });
    const a = await rpc(call, 'recruiter.packet', { leadId: first.leadId });
    const b = await rpc(call, 'recruiter.packet', { leadId: second.leadId });
    assert.notEqual(a.inputHash, b.inputHash);
    const forged = review(a, [{ category: 'clarity', concern: 'Invented citation must fail.', claimIds: [], resumeQuote: 'A nonexistent sentence', postingQuote: '' }]);
    assert.equal((await save(call, a, forged)).state, 'pending');
    assert.equal((await save(call, a, review(b))).state, 'needs_attention', 'another job binding is invalid');
    assert.equal((await save(call, a, review(a))).state, 'needs_attention');
    assert.equal((await sql`SELECT attempts FROM job_work_stages WHERE id=${a.id}`)[0].attempts, 2);
    assert.equal((await sql`SELECT attempts FROM job_work_stages WHERE id=${b.id}`)[0].attempts, 0);
    assert.equal((await save(call, b, review(b))).state, 'complete');
    assert.equal((await rpc(call, 'recruiter.packet', { leadId: first.leadId })).state, 'needs_attention');
  } finally { await fixture.close(); }
});

for (const change of ['bytes', 'claims', 'posting', 'brief'] as const) {
  test(`changed ${change} prevents a stale recruiter save`, async () => {
    const fixture = await setup(); const { call, trusted, sql } = fixture;
    try {
      const { leadId, materials } = await build(call);
      const evaluated = await rpc(call, 'evaluation.run', { leadId });
      assert.equal(evaluated.report.passed, true);
      const packet = await rpc(call, 'recruiter.packet', { leadId });
      if (change === 'bytes') await appendFile(materials.artifacts.find((a: any) => a.kind === 'resume').path, '\n% changed bytes\n');
      if (change === 'claims') await sql`UPDATE resume_truth_claims SET review_status='rejected' WHERE id='experience.1.claim.1'`;
      if (change === 'posting') await rpc(call, 'draft.posting', leadId, POSTING + 'Updated requirements.', 'User verified the changed fictional posting.');
      if (change === 'brief') {
        const message = { id: 'remote', text: 'I prefer remote work.' };
        await rpc(trusted, 'brief.addMessage', message);
        const draft = await rpc(call, 'brief.propose', { expectedDraftHash: null, proposal: { criteria: [{ id: 'mode', topic: 'work_mode', kind: 'preference', state: 'answered', parameter: { field: 'work_mode', modes: ['remote'] }, sources: [{ messageId: message.id, quote: message.text }] }] } });
        await rpc(trusted, 'brief.approve', { reviewedHash: draft.review.contentHash, expectedActiveHash: null });
      }
      await assert.rejects(save(call, packet, review(packet)), /current|changed|selection|materials/i);
      assert.equal((await sql`SELECT attempts FROM job_work_stages WHERE id=${packet.id}`)[0].attempts, 0);
      if (change === 'bytes') {
        const fresh = await rpc(call, 'evaluation.run', { leadId });
        assert.notEqual(fresh.inputHash, evaluated.inputHash);
        assert.equal(fresh.report.passed, false);
        assert.ok(fresh.report.issues.some((issue: any) => issue.code === 'artifact_hash_mismatch'));
        assert.equal((await sql`SELECT state FROM job_work_stages WHERE id=${evaluated.id}`)[0].state, 'stale');
      }
    } finally { await fixture.close(); }
  });
}

test('owner initialization marks interrupted evaluation for attention and allows only one explicit retry', async () => {
  const fixture = await setup(); const { call, sql, store } = fixture;
  try {
    const { leadId } = await build(call);
    const evaluated = await rpc(call, 'evaluation.run', { leadId });
    await sql`UPDATE job_work_stages SET state='pending',result=NULL WHERE id=${evaluated.id}`;
    await initializeService(store);
    const [interrupted] = await sql`SELECT state,attempts,error FROM job_work_stages WHERE id=${evaluated.id}`;
    assert.equal(interrupted.state, 'needs_attention'); assert.match(interrupted.error, /restarted/);
    assert.equal((await rpc(call, 'evaluation.run', { leadId })).reused, true);
    const retried = await rpc(call, 'evaluation.run', { leadId, retry: true });
    assert.equal(retried.report.passed, true);
    assert.equal((await sql`SELECT attempts FROM job_work_stages WHERE id=${evaluated.id}`)[0].attempts, 2);
    await sql`UPDATE job_work_stages SET state='needs_attention' WHERE id=${evaluated.id}`;
    assert.equal((await rpc(call, 'evaluation.run', { leadId, retry: true })).reused, true);
    assert.equal((await sql`SELECT attempts FROM job_work_stages WHERE id=${evaluated.id}`)[0].attempts, 2);
  } finally { await fixture.close(); }
});


test('restoring exact artifact bytes restores saved stages without consuming attempts; posting continuations are independent', async () => {
  const fixture = await setup(); const { call, sql } = fixture;
  try {
    const posting = POSTING.repeat(5) + 'Final posting evidence.';
    const { leadId, materials } = await build(call, 'long-posting', posting);
    const evaluated = await rpc(call, 'evaluation.run', { leadId });
    assert.equal(evaluated.report.passed, true);
    const packet = await rpc(call, 'recruiter.packet', { leadId });
    let reconstructed = packet.posting.text, offset = packet.posting.nextOffset;
    while (offset !== null) {
      const page = await rpc(call, 'recruiter.packet', { leadId, postingOffset: offset });
      assert.equal(page.id, packet.id); assert.equal(page.inputHash, packet.inputHash);
      assert.equal(page.resume.text, packet.resume.text, 'posting continuation does not change the resume window');
      reconstructed += page.posting.text; offset = page.posting.nextOffset;
    }
    assert.equal(reconstructed, posting);
    const result = review(packet, [{ category: 'clarity', concern: 'A human should review the presentation.',
      claimIds: ['profile.name'], resumeQuote: 'Jordan Rivera', postingQuote: '' }]);
    assert.equal((await save(call, packet, result)).state, 'complete');
    const filename = materials.artifacts.find((a: any) => a.kind === 'resume').path;
    const original = await readFile(filename);
    await appendFile(filename, '\n% changed bytes\n');
    const failed = await rpc(call, 'evaluation.run', { leadId });
    assert.equal(failed.report.passed, false);
    assert.equal((await sql`SELECT state FROM job_work_stages WHERE id=${packet.id}`)[0].state, 'stale');
    await writeFile(filename, original);
    const restored = await rpc(call, 'evaluation.run', { leadId });
    assert.equal(restored.reused, true);
    const restoredPacket = await rpc(call, 'recruiter.packet', { leadId });
    assert.equal(restoredPacket.id, packet.id); assert.equal(restoredPacket.state, 'complete');
    assert.equal((await save(call, packet, result)).reused, true);
    assert.equal((await sql`SELECT attempts FROM job_work_stages WHERE id=${packet.id}`)[0].attempts, 1);
    assert.equal((await sql`SELECT attempts FROM job_work_stages WHERE id=${evaluated.id}`)[0].attempts, 1);
  } finally { await fixture.close(); }
});


test('UTF8 recruiter packets stay bounded and all text and selected-claim continuations make progress', async () => {
  const fixture = await setup(); const { call, sql } = fixture;
  try {
    const claims = await rpc(call, 'truth.list');
    const claimIds = claims.filter((claim: any) => /^experience\.\d+\.claim\./.test(claim.id)).map((claim: any) => claim.id).sort();
    const posting = POSTING + '行业经验与成果。'.repeat(800);
    const { leadId, materials } = await build(call, 'utf8', posting, claimIds);
    const evaluated = await rpc(call, 'evaluation.run', { leadId });
    assert.equal(evaluated.report.passed, true);
    // Deliberately replace extracted text only after valid evaluation: this tests
    // byte-budget pagination, not acceptance of fabricated text by the evaluator.
    const text = '行业经验与成果。'.repeat(1200);
    const [saved] = await sql`SELECT result FROM job_work_stages WHERE id=${evaluated.id}`;
    await sql`UPDATE job_work_stages SET result=${JSON.stringify({ ...saved.result, extractedText: text })}::jsonb WHERE id=${evaluated.id}`;
    const first = await rpc(call, 'recruiter.packet', { leadId });
    assert.ok(payloadBytes(first) <= 16000);
    assert.equal(first.selectedClaimIds.length, 20); assert.equal(first.nextClaimOffset, 20);
    assert.ok(first.resume.text.length < 3500, 'multibyte text shrinks the initial resume page');
    for (const [field, parameter, expected] of [['resume', 'offset', text], ['posting', 'postingOffset', posting]] as const) {
      let combined = '', offset: number | null = 0;
      while (offset !== null) {
        const page = await rpc(call, 'recruiter.packet', { leadId, [parameter]: offset });
        assert.ok(payloadBytes(page) <= 16000);
        assert.ok(page[field].text.length > 0);
        const next = page[field].nextOffset;
        assert.ok(next === null || next > offset);
        combined += page[field].text; offset = next;
      }
      assert.equal(combined, expected);
    }
    const recovered: string[] = []; let claimOffset: number | null = 0;
    while (claimOffset !== null) {
      const page = await rpc(call, 'recruiter.packet', { leadId, claimOffset });
      assert.ok(payloadBytes(page) <= 16000); assert.ok(page.selectedClaimIds.length <= 20);
      assert.ok(page.nextClaimOffset === null || page.nextClaimOffset > claimOffset);
      recovered.push(...page.selectedClaimIds); claimOffset = page.nextClaimOffset;
    }
    const [manifest] = await sql`SELECT manifest FROM job_material_manifests WHERE id=${materials.id}`;
    assert.deepEqual(recovered, manifest.manifest.claims.map((claim: any) => claim.id));
    assert.equal(new Set(recovered).size, recovered.length);
  } finally { await fixture.close(); }
});
