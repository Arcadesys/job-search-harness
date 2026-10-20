import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm, writeFile, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { JobdeskStore } from './store';
import { createService, initializeService } from './service';
import { tempRoot } from '../../tests/fixtures/temp-root';
import { loadSample } from '../../tests/fixtures/sample-resume';
import { leadIdForUrl } from '../../lib/job-discovery';
import { PACKET_LIMIT, TEMPLATE_VERSION, rankClaims, makeMaterialManifest, workflowContext, selectionSchema } from '../../lib/job-workflow';
import { payloadBytes } from '../../lib/workflow-hash';
import { parseBuiltinJob, runCollection } from '../../lib/job-collection';

const URL = 'https://www.builtinchicago.org/job/delivery-manager/123';
const POSTING = 'Manage cross-functional programs, delivery and analytics enablement. '.repeat(15);
const html = (description = POSTING, title = 'Delivery Manager') => `<script type="application/ld&#x2B;json">${JSON.stringify({ '@graph': [{ '@type': 'JobPosting', title, description,
  hiringOrganization: { name: 'Example Employer' }, baseSalary: { currency: 'USD', value: { unitText: 'YEAR', maxValue: 150000 } } }] })}</script>`;
async function setup() {
  const root = await tempRoot('jobdesk-workflow-'); const store = await JobdeskStore.open(root);
  await initializeService(store); await loadSample(store);
  await store.sql`UPDATE resume_truth_claims SET review_status='reviewed'`;
  return { root, store, call: createService(store) };
}
async function prepare(call: ReturnType<typeof createService>, leadId: string, claimIds = ['experience.1.claim.1']) {
  const assessment: any = await call({ method: 'workflow.packet', args: [{ leadId, stage: 'assessment' }] });
  await call({ method: 'workflow.save', args: [{ packetId: assessment.id, inputHash: assessment.inputHash,
    result: { recommendation: 'candidate', reasons: [{ text: 'Relevant delivery work.', evidence: 'cross-functional programs' }], uncertainties: [], claimIds } }] });
  const selection: any = await call({ method: 'workflow.packet', args: [{ leadId, stage: 'selection' }] });
  const result: any = await call({ method: 'workflow.save', args: [{ packetId: selection.id, inputHash: selection.inputHash,
    result: { template: TEMPLATE_VERSION, sections: [{ kind: 'experience', claimIds }], outreach: false, unresolved: [] } }] });
  assert.equal(result.state, 'complete');
  return { assessment, selection };
}
async function addVerified(call: ReturnType<typeof createService>, url = URL) {
  const id = leadIdForUrl(url);
  await call({ method: 'leads.add', args: [{ url, title: 'Delivery Manager', organization: 'Example Employer' }] });
  await call({ method: 'draft.posting', args: [id, POSTING, 'User verified the original posting for this synthetic fixture.'] });
  return id;
}

test('selection contract and bounded repair guidance preserve exact saves, replay and claim boundaries', async () => {
  const { root, store, call } = await setup();
  try {
    const leadId = await addVerified(call);
    let revision = 0;
    const packet = async () => {
      const assessment: any = await call({ method: 'workflow.packet', args: [{ leadId, stage: 'assessment' }] });
      await call({ method: 'workflow.save', args: [{ packetId: assessment.id, inputHash: assessment.inputHash,
        result: { recommendation: 'candidate', reasons: [{ text: 'Fictional fit.', evidence: 'cross-functional programs' }], uncertainties: [], claimIds: [] } }] });
      const selected: any = await call({ method: 'workflow.packet', args: [{ leadId, stage: 'selection', revision: `Fictional guidance case ${revision++}` }] });
      assert.ok(payloadBytes(selected) <= PACKET_LIMIT);
      return selected;
    };
    const valid = { template: TEMPLATE_VERSION, sections: [{ kind: 'experience', claimIds: ['experience.1.claim.1'] }], outreach: false, unresolved: [] };
    const save = (p: any, result: unknown): Promise<any> => call({ method: 'workflow.save', args: [{ packetId: p.id, inputHash: p.inputHash, result }] });
    const first = await packet();
    assert.deepEqual(first.responseContract.sectionKinds, selectionSchema.shape.sections.element.shape.kind.options);
    assert.deepEqual(first.responseContract.fields.split(','), Object.keys(selectionSchema.shape));
    assert.equal(first.responseContract.template, TEMPLATE_VERSION);
    assert.match(first.instructions, /Use only.*sections:\[\{kind,claimIds:ID\[\]\}\]/);
    assert.equal(first.candidates.length, 8, 'contract guidance preserves the baseline ranked hint coverage');
    assert.match(first.selectionRules.join(' '), /no prose or repeats.*non-profile.*contiguous.*Auto-insert reviewed.*profile\.name.*email,phone,website.*employer,title,dates.*unresolved must be \[\]/);
    const context = await workflowContext(leadId, store.sql);
    const ranked = rankClaims(context.claims, `${context.lead.title} ${context.posting}`, context.assessment?.result?.claimIds ?? []).slice(0, 8);
    assert.deepEqual(first.candidates.map((c: any) => c.id), ranked.slice(0, first.candidates.length).map(c => c.id), 'packing keeps the same ranked prefix');
    const requiredIds = ['profile.name', 'profile.email', 'experience.1.employer', 'experience.1.title', 'experience.1.dates'];
    const required: any = await call({ method: 'workflow.claims', args: [{ ids: requiredIds, catalogHash: first.catalogHash }] });
    assert.deepEqual(required.claims.map((c: any) => c.id), requiredIds, 'all structural metadata remains retrievable');
    assert.equal((await save(first, valid)).state, 'complete');
    const [original] = await store.sql`SELECT attempts,result FROM job_work_stages WHERE id=${first.id}`;
    assert.equal(original.attempts, 1);
    assert.deepEqual(original.result, valid);
    const built: any = await call({ method: 'workflow.build', args: [{ leadId }] });
    const manifests = await store.sql`SELECT id,attempts FROM job_material_manifests ORDER BY id`;
    const replay = await save(first, { sections: [{ kind: 'PRIVATE_SENTINEL_DO_NOT_ECHO' }] });
    assert.equal(replay.reused, true);
    assert.deepEqual((await store.sql`SELECT attempts,result FROM job_work_stages WHERE id=${first.id}`)[0], original);
    const cached: any = await call({ method: 'workflow.build', args: [{ leadId }] });
    assert.equal(cached.reused, true); assert.equal(cached.id, built.id);
    assert.deepEqual(await store.sql`SELECT id,attempts FROM job_material_manifests ORDER BY id`, manifests);
    const secret = 'PRIVATE_SENTINEL_DO_NOT_ECHO';
    const cases: { result: unknown; code: string; path: string; guidance: RegExp }[] = [
      { result: { ...valid, sections: [{ kind: secret, claimIds: ['experience.1.claim.1'] }] }, code: 'invalid_value', path: 'sections.0.kind', guidance: /profile, summary, experience, accomplishments, skills, education, other/ },
      { result: { ...valid, sections: secret }, code: 'invalid_type', path: 'sections', guidance: /array of sections/ },
      { result: { ...valid, sections: Array.from({ length: 21 }, () => valid.sections[0]) }, code: 'too_big', path: 'sections', guidance: /at most 20 items/ },
      { result: { ...valid, sections: [{ kind: 'experience', claimIds: [123] }] }, code: 'invalid_type', path: 'sections.0.claimIds.0', guidance: /claim ID string/ },
      { result: { ...valid, [secret]: secret }, code: 'unrecognized_keys', path: 'result', guidance: /Remove undeclared fields/ },
      { result: { ...valid, sections: [{ kind: 'experience', claimIds: [secret, secret] }] }, code: 'CLAIM_NOT_REVIEWED', path: 'sections', guidance: /reviewed claims/ },
      { result: { ...valid, sections: [valid.sections[0], { kind: 'other', claimIds: ['experience.1.claim.1'] }] }, code: 'DUPLICATE_CLAIM_IDS', path: 'sections', guidance: /across all sections/ },
      { result: { ...valid, sections: [{ kind: 'experience', claimIds: ['experience.1.claim.1', 'experience.2.claim.1', 'experience.1.claim.2'] }] }, code: 'ROLE_NOT_CONTIGUOUS', path: 'sections.0.claimIds', guidance: /contiguous group/ },
      { result: { ...valid, sections: [{ kind: 'experience', claimIds: ['skills.1'] }] }, code: 'EXPERIENCE_GROUP_REQUIRED', path: 'sections.0.claimIds', guidance: /kind other/ },
      { result: { ...valid, unresolved: [secret] }, code: 'UNRESOLVED_REQUIREMENTS', path: 'unresolved', guidance: /unresolved: \[\]/ },
      { result: { ...valid, sections: [{ kind: 'profile', claimIds: ['profile.name'] }] }, code: 'NON_PROFILE_CLAIM_REQUIRED', path: 'sections', guidance: /non-profile claim/ },
      { result: { ...valid, unresolved: [secret.repeat(1000)] }, code: 'RESULT_TOO_LARGE', path: 'result', guidance: /serialized result/ },
    ];
    for (const expected of cases) {
      const p = await packet();
      const rejected = await save(p, expected.result);
      assert.equal(rejected.state, 'pending'); assert.equal(rejected.repairRemaining, 1);
      assert.equal(rejected.issues[0].code, expected.code); assert.equal(rejected.issues[0].path, expected.path);
      assert.match(rejected.issues[0].guidance, expected.guidance);
      assert.ok(payloadBytes(rejected) < 2000);
      assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE_SENTINEL|Jordan|jordan@|Maple Analytics/);
      assert.doesNotMatch((await store.sql`SELECT error FROM job_work_stages WHERE id=${p.id}`)[0].error, /PRIVATE_SENTINEL/);
      assert.equal((await save(p, valid)).state, 'complete');
      assert.equal((await store.sql`SELECT attempts FROM job_work_stages WHERE id=${p.id}`)[0].attempts, 2);
    }
    // Truncate diagnostics structurally; neither arbitrary keys nor invalid values may escape.
    const malformed = await packet();
    const many = await save(malformed, { ...valid, sections: Array.from({ length: 12 }, () => ({ kind: secret, claimIds: [], [secret]: secret })) });
    assert.equal(many.issues.length, 5); assert.ok(payloadBytes(many) < 2000);
    assert.doesNotMatch(JSON.stringify(many), /PRIVATE_SENTINEL/);
    assert.equal((await save(malformed, {})).state, 'needs_attention');
    assert.equal((await save(malformed, valid)).state, 'needs_attention');
    const [stopped] = await store.sql`SELECT attempts,result FROM job_work_stages WHERE id=${malformed.id}`;
    assert.equal(stopped.attempts, 2); assert.equal(stopped.result, null);
    const stale = await packet();
    await call({ method: 'workflow.configure', args: [{ preferences: 'Fictional changed preference.' }] });
    await assert.rejects(save(stale, valid), /Inputs changed/);
    assert.equal((await store.sql`SELECT attempts FROM job_work_stages WHERE id=${stale.id}`)[0].attempts, 0);
    // A valid-looking existing ID still cannot bypass review.
    await store.sql`UPDATE resume_truth_claims SET review_status='unreviewed' WHERE id='skills.1'`;
    const unreviewed = await save(await packet(), { ...valid, sections: [{ kind: 'skills', claimIds: ['skills.1'] }] });
    assert.equal(unreviewed.issues[0].code, 'CLAIM_NOT_REVIEWED');
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('selection prerequisites give safe guidance without inventing missing reviewed metadata', async () => {
  const { root, store, call } = await setup();
  try {
    const leadId = await addVerified(call);
    const valid = { template: TEMPLATE_VERSION, sections: [{ kind: 'experience', claimIds: ['experience.1.claim.1'] }], outreach: false, unresolved: [] };
    for (const [id, code, guidance] of [
      ['profile.name', 'MISSING_REVIEWED_NAME', 'profile.name'],
      ['profile.email', 'MISSING_REVIEWED_CONTACT', 'profile.email'],
      ['experience.1.dates', 'MISSING_REVIEWED_ROLE_METADATA', 'experience.N.dates'],
    ]) {
      await store.sql`UPDATE resume_truth_claims SET review_status='unreviewed' WHERE id=${id}`;
      const assessment: any = await call({ method: 'workflow.packet', args: [{ leadId, stage: 'assessment' }] });
      await call({ method: 'workflow.save', args: [{ packetId: assessment.id, inputHash: assessment.inputHash,
        result: { recommendation: 'candidate', reasons: [{ text: 'Fictional fit.', evidence: 'cross-functional programs' }], uncertainties: [], claimIds: [] } }] });
      const p: any = await call({ method: 'workflow.packet', args: [{ leadId, stage: 'selection' }] });
      const rejected: any = await call({ method: 'workflow.save', args: [{ packetId: p.id, inputHash: p.inputHash, result: valid }] });
      assert.equal(rejected.state, 'pending'); assert.equal(rejected.issues[0].code, code);
      assert.ok(rejected.issues[0].guidance.includes(guidance));
      assert.doesNotMatch(JSON.stringify(rejected), /Jordan|jordan@|Maple Analytics|09\/2022/);
      await store.sql`UPDATE resume_truth_claims SET review_status='reviewed' WHERE id=${id}`;
      await assert.rejects(call({ method: 'workflow.save', args: [{ packetId: p.id, inputHash: p.inputHash, result: valid }] }), /Inputs changed/);
    }
    // Oversized candidate text is removable; the response contract itself must survive packet compaction.
    await store.sql`UPDATE resume_truth_claims SET claim=${'cross-functional '.repeat(2000)} WHERE id='experience.1.claim.1'`;
    const assessment: any = await call({ method: 'workflow.packet', args: [{ leadId, stage: 'assessment' }] });
    await call({ method: 'workflow.save', args: [{ packetId: assessment.id, inputHash: assessment.inputHash,
      result: { recommendation: 'candidate', reasons: [{ text: 'Fictional fit.', evidence: 'cross-functional programs' }], uncertainties: [], claimIds: [] } }] });
    const compact: any = await call({ method: 'workflow.packet', args: [{ leadId, stage: 'selection' }] });
    assert.ok(payloadBytes(compact) <= PACKET_LIMIT);
    assert.ok(compact.responseContract); assert.equal(compact.selectionRules.length, 3);
    const [saved] = await store.sql`SELECT posting_text FROM job_leads WHERE id=${leadId}`;
    assert.equal(compact.posting.text, saved.posting_text);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('compact packets, exact ordering, separate exports, cache reuse, approval, invalidation and restore persistence', async () => {
  const { root, store, call } = await setup();
  let reopened: JobdeskStore | undefined;
  try {
    const id = await addVerified(call);
    const claims: any = await call({ method: 'truth.list', args: [] });
    const bulletIds = claims.filter((claim: any) => /^experience\.1\.claim\./.test(claim.id)).map((c: any) => c.id);
    assert.ok(bulletIds.length > 1);
    const ordered = [bulletIds[2], bulletIds[0]];
    const { assessment, selection } = await prepare(call, id, ordered);
    assert.ok(payloadBytes(assessment) <= PACKET_LIMIT);
    assert.ok(assessment.posting.nextOffset === null || assessment.posting.nextOffset > 0);
    const legacy: any = { leadId: id, posting: POSTING, reviewedTruths: claims };
    const ratio = (payloadBytes(assessment) + payloadBytes(selection)) / payloadBytes(legacy);
    assert.ok(ratio <= 0.5, `Compact full assessment+selection payload ${payloadBytes(assessment) + payloadBytes(selection)} vs legacy ${payloadBytes(legacy)}; ratio ${ratio}`);
    const hidden = claims.find((c: any) => !assessment.candidates.some((candidate: any) => candidate.id === c.id));
    assert.ok(hidden, 'candidate shortlist is smaller than the approved bank');
    const lookup: any = await call({ method: 'workflow.claims', args: [{ ids: [hidden.id], catalogHash: assessment.catalogHash }] });
    assert.equal(lookup.claims[0].id, hidden.id, 'claims outside the initial shortlist remain accessible');
    assert.ok((payloadBytes(assessment) + payloadBytes(selection) + payloadBytes(lookup)) / payloadBytes(legacy) <= .5,
      'the full packet comparison still clears 50% after extra evidence retrieval');
    console.log(JSON.stringify({ benchmark: 'fixed-fictional-resume', legacyPreparationBytes: payloadBytes(legacy), compactPreparationBytes: payloadBytes(assessment) + payloadBytes(selection),
      previousSelectionHintLimit: 8, selectionHints: selection.candidates.length, extraRetrievalBytes: payloadBytes(lookup), withRetrievalRatio: (payloadBytes(assessment) + payloadBytes(selection) + payloadBytes(lookup)) / payloadBytes(legacy), inputTokens: null, providerCost: null }));
    const built: any = await call({ method: 'workflow.build', args: [{ leadId: id }] });
    assert.equal(built.state, 'current'); assert.equal(built.artifacts.length, 2);
    assert.equal(built.validation.visual, 'pending');
    await assert.rejects(call({ method: 'draft.approve', args: [id, built.draftVersion] }), /rendered review/);
    await call({ method: 'workflow.review', args: [{ id: built.id, inputHash: built.inputHash, passed: true, note: 'Synthetic test inspection; actual rendered QA runs separately.' }] });
    await call({ method: 'evaluation.run', args: [{ leadId: id }] });
    await call({ method: 'draft.approve', args: [id, built.draftVersion] });
    const [manifest] = await store.sql`SELECT manifest FROM job_material_manifests WHERE id=${built.id}`;
    const lines = manifest.manifest.sections.flatMap((s: any) => s.lines);
    assert.ok(lines.indexOf(claims.find((c: any) => c.id === ordered[0]).claim) < lines.indexOf(claims.find((c: any) => c.id === ordered[1]).claim));
    assert.ok(manifest.manifest.claims.some((c: any) => c.id === 'experience.1.employer'));
    assert.ok(manifest.manifest.claims.some((c: any) => c.id === 'experience.1.dates'));
    await assert.rejects(call({ method: 'draft.edit', args: [id, 'Invented replacement', ''] }), /claim selection/);
    const reused: any = await call({ method: 'workflow.build', args: [{ leadId: id }] });
    assert.equal(reused.reused, true); assert.equal(reused.id, built.id);
    assert.deepEqual(reused.artifacts.map((a: any) => a.id), built.artifacts.map((a: any) => a.id));
    const cached: any = await call({ method: 'workflow.packet', args: [{ leadId: id, stage: 'assessment' }] });
    assert.equal(cached.reused, true);
    assert.equal(Number((await store.sql`SELECT count(*) AS n FROM job_material_manifests`)[0].n), 1);
    // New unrelated experience changes selection, without corrupting an existing artifact or approval.
    await call({ method: 'truth.importText', args: ['Learned a new fictional topic', 'Synthetic new approved claim for invalidation testing.'] });
    await store.sql`UPDATE resume_truth_claims SET review_status='reviewed' WHERE claim='Learned a new fictional topic'`;
    const status: any = await call({ method: 'workflow.status', args: [{ leadId: id }] });
    assert.equal(status.materials[0].state, 'current');
    assert.ok(status.stages.some((stage: any) => stage.state === 'stale'));
    const approval = (await store.sql`SELECT review_status FROM job_application_drafts WHERE lead_id=${id}`)[0];
    assert.equal(approval.review_status, 'approved');
    // A used claim revocation invalidates the actual files for further approval/use.
    await store.sql`UPDATE resume_truth_claims SET review_status='rejected' WHERE id=${ordered[0]}`;
    const revoked: any = await call({ method: 'workflow.status', args: [{ leadId: id }] });
    assert.equal(revoked.materials[0].state, 'stale');
    assert.equal((await store.sql`SELECT review_status FROM job_application_drafts WHERE lead_id=${id}`)[0].review_status, 'review_required');
    // Durable artifacts survive owner restart and backup/restore.
    const backup = await store.backup();
    await store.close(); reopened = await JobdeskStore.open(root); await initializeService(reopened);
    assert.equal(Number((await reopened.sql`SELECT count(*) AS n FROM job_material_manifests`)[0].n), 1);
    await reopened.close(); reopened = undefined;
    const restoredRoot = await tempRoot('jobdesk-restored-workflow-');
    try {
      const tar = await readFile(path.join(backup.directory, 'database.tar.gz'));
      const restored = await JobdeskStore.open(restoredRoot, undefined, new Blob([new Uint8Array(tar)]), async (destination) => {
        await mkdir(path.join(destination, 'artifacts'), { recursive: true });
        await cp(path.join(backup.directory, 'artifacts'), path.join(destination, 'artifacts'), { recursive: true });
      });
      try { assert.equal(Number((await restored.sql`SELECT count(*) AS n FROM job_material_manifests`)[0].n), 1); }
      finally { await restored.close(); }
    } finally { await rm(restoredRoot, { recursive: true, force: true }); }
  } finally { await reopened?.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('stale writes, bounded repair, uncertain fields, exclusions and user decisions', async () => {
  const { root, store, call } = await setup();
  try {
    const id = await addVerified(call);
    const stale: any = await call({ method: 'workflow.packet', args: [{ leadId: id, stage: 'assessment' }] });
    await call({ method: 'workflow.configure', args: [{ preferences: 'Changed criteria' }] });
    await assert.rejects(call({ method: 'workflow.save', args: [{ packetId: stale.id, inputHash: stale.inputHash, result: {} }] }), /Inputs changed/);
    const packet: any = await call({ method: 'workflow.packet', args: [{ leadId: id, stage: 'assessment' }] });
    const first: any = await call({ method: 'workflow.save', args: [{ packetId: packet.id, inputHash: packet.inputHash, result: { invented: 'claim' } }] });
    assert.equal(first.state, 'pending'); assert.equal(first.repairRemaining, 1);
    const second: any = await call({ method: 'workflow.save', args: [{ packetId: packet.id, inputHash: packet.inputHash, result: {} }] });
    assert.equal(second.state, 'needs_attention');
    const third: any = await call({ method: 'workflow.packet', args: [{ leadId: id, stage: 'assessment' }] });
    assert.equal(third.state, 'needs_attention');
    assert.equal((await store.sql`SELECT attempts FROM job_work_stages WHERE id=${packet.id}`)[0].attempts, 2);
    await call({ method: 'workflow.configure', args: [{ minimumAnnualSalary: 160000 }] });
    assert.equal((await call({ method: 'exclusions.list', args: [] }) as any).exclusions.filter((e: any) => e.current).length, 0, 'unknown salary cannot exclude');
    await call({ method: 'workflow.configure', args: [{ excludedEmployers: ['Example Employer'] }] });
    const { exclusions }: any = await call({ method: 'exclusions.list', args: [] });
    assert.equal(exclusions[0].current, true);
    assert.equal((await store.sql`SELECT decision FROM job_leads WHERE id=${id}`)[0].decision, 'review');
    let jobs: any = await call({ method: 'workflow.jobs', args: [{}] }); assert.equal(jobs.jobs.length, 0);
    await call({ method: 'exclusions.restore', args: [exclusions[0].id] });
    jobs = await call({ method: 'workflow.jobs', args: [{}] }); assert.equal(jobs.jobs[0].id, id);
    await call({ method: 'workflow.jobs', args: [{}] });
    assert.ok((await call({ method: 'exclusions.list', args: [] }) as any).exclusions[0].restored_at, 'same-version filtering cannot undo restoration');
    await call({ method: 'workflow.configure', args: [{ preferences: 'Changed evidence preferences', excludedEmployers: ['Example Employer'] }] });
    jobs = await call({ method: 'workflow.jobs', args: [{}] }); assert.equal(jobs.jobs.length, 0, 'changed inputs can be reconsidered');
    await call({ method: 'leads.update', args: [{ id, decision: 'keep', verification: 'verified' }] });
    jobs = await call({ method: 'workflow.jobs', args: [{}] }); assert.equal(jobs.jobs.length, 1, 'explicit keep survives automatic exclusion');
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('collection partial success, original verification, changed snapshots, resume, restart and nonblocking owner', async () => {
  const { root, store, call } = await setup();
  try {
    let requests = 0, fail = true;
    const fetcher: typeof fetch = async (url) => {
      requests++;
      if (String(url).endsWith('/jobs')) return new Response('<main><a href="/job/delivery-manager/123">One</a><a href="/job/other/456">Two</a></main>');
      if (String(url).endsWith('/456') && fail) return new Response('', { status: 503 });
      return new Response(html());
    };
    const result: any = await runCollection({ source: 'builtin', urls: [] }, store, { fetcher, delayMs: 0 });
    assert.equal(result.state, 'partial'); assert.equal(result.counts.saved, 1); assert.equal(result.counts.failed, 1);
    assert.match(result.coverage, /first page/);
    const id = leadIdForUrl(URL);
    const [lead] = await store.sql`SELECT * FROM job_leads WHERE id=${id}`;
    assert.equal(lead.verification_status, 'unverified'); assert.equal(lead.user_verified_at, null);
    assert.ok(lead.last_seen_at); assert.ok(lead.posting_retrieved_at);
    await call({ method: 'draft.posting', args: [id, POSTING, 'Verified against the original source for fixture.'] });
    await store.sql`UPDATE job_leads SET notes='Keep this private note',decision='keep' WHERE id=${id}`;
    fail = false;
    const resumed: any = await runCollection({ source: 'builtin', runId: result.id, urls: [] }, store, { fetcher, delayMs: 0 });
    assert.equal(resumed.counts.saved, 2); assert.equal(resumed.counts.failed, 0); assert.equal(requests, 4, 'resume only refetches failed targets');
    const before = requests;
    const reused: any = await runCollection({ source: 'builtin', runId: result.id, urls: [] }, store, { fetcher, delayMs: 0 });
    assert.equal(reused.reused, true); assert.equal(requests, before);
    await runCollection({ source: 'builtin', urls: [URL] }, store, { delayMs: 0, fetcher: async () => new Response(html(`${POSTING} Changed requirements.`, 'Changed title')) });
    const [changed] = await store.sql`SELECT * FROM job_leads WHERE id=${id}`;
    assert.equal(changed.title, 'Changed title'); assert.equal(changed.notes, 'Keep this private note'); assert.equal(changed.decision, 'keep');
    assert.equal(changed.verification_status, 'stale');
    assert.equal(Number((await store.sql`SELECT count(*) AS n FROM job_source_observations WHERE lead_id=${id}`)[0].n), 2);
    // A slow external response cannot occupy the store queue.
    let release!: () => void; let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const block = new Promise<void>((resolve) => { release = resolve; });
    const running = runCollection({ source: 'builtin', urls: [URL] }, store, { delayMs: 0, fetcher: async () => { started(); await block; return new Response(html()); } });
    await waiting;
    const health: any = await Promise.race([call({ method: 'health', args: [] }), new Promise((_, reject) => setTimeout(() => reject(new Error('Owner queue blocked by fetch')), 3000))]);
    assert.equal(health.ok, true); release(); await running;
    await store.sql`UPDATE job_collection_runs SET state='running' WHERE id=${result.id}`;
    await initializeService(store);
    assert.equal((await store.sql`SELECT state FROM job_collection_runs WHERE id=${result.id}`)[0].state, 'partial');
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('damaged files and missing structural claims stop material approval', async () => {
  const { root, store, call } = await setup();
  try {
    const id = await addVerified(call);
    await prepare(call, id);
    await store.sql`UPDATE resume_truth_claims SET review_status='unreviewed' WHERE id='experience.1.dates'`;
    await assert.rejects(call({ method: 'workflow.build', args: [{ leadId: id }] }), /selection|missing/);
    await store.sql`UPDATE resume_truth_claims SET review_status='reviewed' WHERE id='experience.1.dates'`;
    await prepare(call, id);
    const built: any = await call({ method: 'workflow.build', args: [{ leadId: id }] });
    await writeFile(built.artifacts[0].path, 'damaged');
    await assert.rejects(call({ method: 'workflow.review', args: [{ id: built.id, inputHash: built.inputHash, passed: true, note: 'Must fail after file corruption.' }] }), /checksum/);
    const check: any = await call({ method: 'workflow.build', args: [{ leadId: id }] });
    assert.equal(check.state, 'needs_attention');
    const repaired: any = await call({ method: 'workflow.build', args: [{ leadId: id, repair: true }] });
    assert.equal(repaired.state, 'current');
    assert.notEqual(repaired.artifacts[0].id, built.artifacts[0].id);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('claim retrieval can find evidence beyond preferred search-stage hints', () => {
  const claims: any[] = [{ id: 'one', claim: 'Program delivery', reviewStatus: 'reviewed' }, { id: 'two', claim: 'Accessibility testing for screen readers', reviewStatus: 'reviewed' }];
  assert.equal(rankClaims(claims, 'screen readers accessibility', ['one'])[0].id, 'one');
  assert.equal(rankClaims(claims, 'screen readers accessibility')[0].id, 'two');
  assert.equal(parseBuiltinJob(html(), URL).salary?.maximum, 150000);
});

test('assistant verification does not claim user verification and retains the complete original evidence', async () => {
  const { root, store, call } = await setup();
  try {
    const id = await addVerified(call);
    await assert.rejects(call({ method: 'workflow.savePosting', args: [{ leadId: id, text: 'snippet', sourceNote: 'Synthetic original.' }] }));
    await call({ method: 'workflow.savePosting', args: [{ leadId: id, text: `${POSTING} Additional original requirement.`, sourceNote: 'Assistant inspected the original source for a synthetic fixture.' }] });
    const [lead] = await store.sql`SELECT user_verified_at,verification_status,posting_text FROM job_leads WHERE id=${id}`;
    assert.equal(lead.user_verified_at, null); assert.equal(lead.verification_status, 'verified');
    const posting: any = await call({ method: 'workflow.posting', args: [{ leadId: id }] });
    assert.match(posting.text, /Additional original requirement/);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('long claim continuations and older exclusions remain reachable; interleaved role attribution is rejected', async () => {
  const { root, store, call } = await setup();
  try {
    const id = await addVerified(call);
    const longClaim = '行业经验与成果'.repeat(400);
    await call({ method: 'truth.importText', args: [longClaim, 'Synthetic long claim for continuation coverage.'] });
    await store.sql`UPDATE resume_truth_claims SET review_status='reviewed' WHERE claim=${longClaim}`;
    const [claim] = await store.sql`SELECT id FROM resume_truth_claims WHERE claim=${longClaim}`;
    let textOffset: number | null = 0, full = '';
    while (textOffset !== null) {
      const page: any = await call({ method: 'workflow.claims', args: [{ ids: [claim.id], textOffset }] });
      assert.ok(payloadBytes(page) <= PACKET_LIMIT);
      full += page.claims[0].claim; textOffset = page.claims[0].nextTextOffset;
    }
    assert.equal(full, longClaim);
    for (let n = 0; n < 26; n++) await store.sql`INSERT INTO job_exclusions(id,lead_id,input_hash,rule,evidence)
      VALUES(gen_random_uuid(),${id},${String(n).padStart(64, '0')},'fixture','Synthetic exclusion evidence')`;
    const first: any = await call({ method: 'exclusions.list', args: [] });
    assert.equal(first.exclusions.length, 25); assert.equal(first.nextOffset, 25);
    const last: any = await call({ method: 'exclusions.list', args: [{ offset: first.nextOffset }] });
    assert.equal(last.exclusions.length, 1); assert.equal(last.nextOffset, null);
    await call({ method: 'exclusions.restore', args: [last.exclusions[0].id] });
    const context = await workflowContext(id, store.sql);
    assert.throws(() => makeMaterialManifest({ template: TEMPLATE_VERSION, sections: [{ kind: 'experience',
      claimIds: ['experience.1.claim.1','experience.2.claim.1','experience.1.claim.2'] }], outreach: false, unresolved: [] }, context), /same role together/);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('explicit material revisions preserve intent and returning to a saved selection rebinds the cached artifacts', async () => {
  const { root, store, call } = await setup();
  try {
    const id = await addVerified(call); await prepare(call, id);
    const original: any = await call({ method: 'workflow.build', args: [{ leadId: id }] });
    const revision: any = await call({ method: 'workflow.packet', args: [{ leadId: id, stage: 'selection', revision: 'Put skills before work experience.' }] });
    assert.equal(revision.tailoringInstructions, 'Put skills before work experience.');
    assert.equal(revision.reused, false);
    const saved: any = await call({ method: 'workflow.save', args: [{ packetId: revision.id, inputHash: revision.inputHash, result: {
      template: TEMPLATE_VERSION, sections: [{ kind: 'skills', claimIds: ['skills.1'] }, { kind: 'experience', claimIds: ['experience.1.claim.1'] }], outreach: false, unresolved: [] } }] });
    assert.equal(saved.state, 'complete');
    const revised: any = await call({ method: 'workflow.build', args: [{ leadId: id }] });
    assert.notEqual(revised.id, original.id);
    const [draft] = await store.sql`SELECT resume_variant FROM job_application_drafts WHERE lead_id=${id}`;
    assert.ok(draft.resume_variant.indexOf('Skills') < draft.resume_variant.indexOf('Experience'));
    const returned: any = await call({ method: 'workflow.packet', args: [{ leadId: id, stage: 'selection', revision: '' }] });
    assert.equal(returned.reused, true, 'returning to identical inputs reuses their saved model result');
    const restored: any = await call({ method: 'workflow.build', args: [{ leadId: id }] });
    assert.equal(restored.reused, true); assert.equal(restored.id, original.id);
    assert.deepEqual(restored.artifacts.map((a: any) => a.id), original.artifacts.map((a: any) => a.id));
    const [active] = await store.sql`SELECT material_manifest_id,review_status FROM job_application_drafts WHERE lead_id=${id}`;
    assert.equal(active.material_manifest_id, original.id); assert.equal(active.review_status, 'review_required');
    assert.equal((await store.sql`SELECT count(*)::int AS n FROM job_material_manifests WHERE state='current'`)[0].n, 1);
    assert.equal((await store.sql`SELECT sum(attempts)::int AS n FROM job_material_manifests`)[0].n, 2, 'restoring a cached result performs no extra render');
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('an unconfigured feed does not block valid feeds or consume a poll; fixing its URL resumes only that source', async () => {
  const { root, store, call } = await setup();
  try {
    const searches = [{ id: 'one', lane: 'One', location: '', query: 'synthetic first search', enabled: true, feedUrl: 'https://www.google.com/alerts/feeds/1/2' },
      { id: 'two', lane: 'Two', location: '', query: 'synthetic second search', enabled: true, feedUrl: '' }];
    await call({ method: 'search.save', args: [searches] });
    let fetched = 0;
    const fetcher: typeof fetch = async () => { fetched++; return new Response(`<feed><entry><title>Source ${fetched}</title><link href="https://example.test/feed-job-${fetched}"/></entry></feed>`); };
    const first: any = await runCollection({ source: 'feeds', urls: [] }, store, { delayMs: 0, fetcher });
    assert.equal(first.state, 'partial'); assert.equal(first.counts.saved, 1); assert.equal(first.counts.failed, 1); assert.equal(fetched, 1);
    assert.equal((await store.sql`SELECT calls_used FROM job_search_usage`)[0].calls_used, 1);
    searches[1].feedUrl = 'https://www.google.com/alerts/feeds/3/4';
    await call({ method: 'search.save', args: [searches] });
    const resumed: any = await runCollection({ source: 'feeds', urls: [], runId: first.id }, store, { delayMs: 0, fetcher });
    assert.equal(resumed.state, 'complete'); assert.equal(resumed.counts.saved, 2); assert.equal(resumed.counts.failed, 0); assert.equal(fetched, 2);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
