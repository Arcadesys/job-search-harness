import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tempRoot } from '../../tests/fixtures/temp-root';
import { PGlite } from '@electric-sql/pglite';
import { parameterizedSql, type Sql } from '../../lib/job-storage';
import { leadIdForUrl } from '../../lib/job-discovery';
import { TEMPLATE_VERSION, workflowContext, makeMaterialManifest, materialFingerprint } from '../../lib/job-workflow';
import { loadSample } from '../../tests/fixtures/sample-resume';
import { bootstrap } from './bootstrap';
import { migrate } from './migrate';
import { createService } from './service';
import { JobdeskStore } from './store';

const POSTING = 'Manage cross-functional programs, delivery and analytics enablement. '.repeat(15);
const MESSAGE = { id: 'remote', text: 'I prefer remote work.' };
const proposal = (kind: 'preference' | 'hard_requirement' = 'preference') => ({ criteria: [{
  id: 'mode', topic: 'work_mode', kind, state: 'answered',
  parameter: { field: 'work_mode', modes: ['remote'] },
  sources: [{ messageId: MESSAGE.id, quote: MESSAGE.text }],
}] });

async function setup() {
  const db = await PGlite.create();
  await migrate(db);
  const sql = parameterizedSql(db);
  // Only storage ownership/filesystem handling is replaced. Exercise the actual
  // owner queue and PGlite transactions without weakening privateRoot's guard.
  const store = Object.assign(Object.create(JobdeskStore.prototype), {
    root: '/unused-in-memory-jobdesk', db, sql, tail: Promise.resolve(), closing: false,
  }) as JobdeskStore;
  await store.run((sql: Sql) => bootstrap(sql));
  await loadSample(store);
  await store.run((sql: Sql) => sql`UPDATE resume_truth_claims SET review_status='reviewed'`);
  return { db, store, sql, call: createService(store), trusted: createService(store, { trustedUserActions: true }) };
}
type Call = ReturnType<typeof createService>;
const rpc = (call: Call, method: string, ...args: unknown[]): Promise<any> => call({ method, args });
async function addVerified(call: Call, suffix = 'one') {
  const url = `https://example.test/jobs/${suffix}`;
  const id = leadIdForUrl(url);
  await rpc(call, 'leads.add', { url, title: 'Delivery Manager', organization: 'Example Employer' });
  await rpc(call, 'draft.posting', id, POSTING, 'User verified this fictional original posting.');
  return id;
}
async function assess(call: Call, leadId: string) {
  const packet = await rpc(call, 'workflow.packet', { leadId, stage: 'assessment' });
  const saved = await rpc(call, 'workflow.save', { packetId: packet.id, inputHash: packet.inputHash,
    result: { recommendation: 'candidate', reasons: [{ text: 'Relevant delivery work.', evidence: 'cross-functional programs' }],
      uncertainties: [], claimIds: ['experience.1.claim.1'] } });
  assert.equal(saved.state, 'complete');
  return packet;
}

test('brief writes require trusted service construction and cannot be spoofed by RPC fields', async () => {
  const { db, sql, call, trusted } = await setup();
  try {
    const requests = [
      { method: 'brief.addMessage', args: [MESSAGE] },
      { method: 'brief.approve', args: [{ reviewedHash: 'a'.repeat(64), expectedActiveHash: null }] },
      { method: 'brief.cancelDraft', args: [{ expectedDraftHash: 'a'.repeat(64) }] },
    ];
    for (const request of requests) {
      await assert.rejects(call(request), /authenticated cockpit/);
      await assert.rejects(call({ ...request, trustedUserActions: true }));
      await assert.rejects(call({ ...request, args: [{ ...request.args[0], trustedUserActions: true }] }), /authenticated cockpit/);
    }
    assert.equal((await sql`SELECT count(*)::int AS n FROM job_search_brief_messages`)[0].n, 0);
    await rpc(trusted, 'brief.addMessage', MESSAGE);
    const draft = await rpc(call, 'brief.propose', { proposal: proposal(), expectedDraftHash: null });
    await assert.rejects(call({ method: 'brief.approve', args: [{ reviewedHash: draft.review.contentHash, expectedActiveHash: null }], options: { trustedUserActions: true } }));
    assert.equal((await rpc(call, 'brief.read')).active, null);
    const approved = await rpc(trusted, 'brief.approve', { reviewedHash: draft.review.contentHash, expectedActiveHash: null });
    assert.equal(approved.active.identity.contentHash, draft.review.contentHash);
    const revision = await rpc(call, 'brief.propose', { proposal: proposal('hard_requirement'), expectedDraftHash: null });
    assert.equal((await rpc(trusted, 'brief.cancelDraft', { expectedDraftHash: revision.review.contentHash })).cancelled, true);
    const state = await rpc(call, 'brief.read');
    assert.equal(state.draft, null);
    assert.deepEqual(state.active.identity, approved.active.identity);
  } finally { await db.close(); }
});

test('only approved brief identity invalidates workflow caches and enters packets, preserving human choices and truth', async () => {
  const { db, store, sql, call, trusted } = await setup();
  try {
    const leadId = await addVerified(call);
    await rpc(call, 'leads.update', { id: leadId, decision: 'keep', stage: 'preparing', notes: 'Human decision remains authoritative.' });
    const passedId = await addVerified(call, 'passed');
    await rpc(call, 'leads.update', { id: passedId, decision: 'pass', stage: 'closed' });
    const humans = await sql`SELECT id,decision,application_stage,notes FROM job_leads ORDER BY id`;
    const truth = await rpc(call, 'truth.list');
    const old = await assess(call, leadId);
    const originalContext = await store.run((sql) => workflowContext(leadId, sql));
    const materialSelection: Parameters<typeof makeMaterialManifest>[0] = { template: TEMPLATE_VERSION,
      sections: [{ kind: 'experience', claimIds: ['experience.1.claim.1'] }], outreach: false, unresolved: [] };
    const manifest = makeMaterialManifest(materialSelection, originalContext);
    const originalMaterialHash = materialFingerprint(manifest, originalContext);
    await rpc(trusted, 'brief.addMessage', MESSAGE);
    const draft = await rpc(call, 'brief.propose', { proposal: proposal(), expectedDraftHash: null });
    const pending = await rpc(call, 'workflow.packet', { leadId, stage: 'assessment' });
    assert.equal(pending.id, old.id);
    assert.equal(pending.inputHash, old.inputHash);
    assert.equal(pending.reused, true);
    const pendingContext = await store.run((sql) => workflowContext(leadId, sql));
    assert.equal(pendingContext.selectionHash, originalContext.selectionHash);
    assert.equal(materialFingerprint(manifest, pendingContext), originalMaterialHash);
    const approved = await rpc(trusted, 'brief.approve', { reviewedHash: draft.review.contentHash, expectedActiveHash: null });
    assert.equal((await sql`SELECT state FROM job_work_stages WHERE id=${old.id}`)[0].state, 'stale');
    const fresh = await rpc(call, 'workflow.packet', { leadId, stage: 'assessment' });
    assert.notEqual(fresh.inputHash, old.inputHash);
    assert.notEqual(fresh.id, old.id);
    assert.deepEqual(fresh.criteria.approvedSearchBrief.identity, approved.active.identity);
    assert.equal(fresh.criteria.approvedSearchBrief.preferences.length, 1);
    assert.deepEqual(fresh.criteria.approvedSearchBrief.hardRequirements, []);
    const activeContext = await store.run((sql) => workflowContext(leadId, sql));
    assert.notEqual(activeContext.selectionHash, originalContext.selectionHash);
    assert.notEqual(materialFingerprint(manifest, activeContext), originalMaterialHash);
    assert.deepEqual(makeMaterialManifest(materialSelection, activeContext).approvedSearchBrief, approved.active.identity);
    const revision = await rpc(call, 'brief.propose', { proposal: proposal('hard_requirement'), expectedDraftHash: null });
    const stillActive = await rpc(call, 'workflow.packet', { leadId, stage: 'assessment' });
    assert.equal(stillActive.id, fresh.id);
    assert.equal(stillActive.inputHash, fresh.inputHash);
    assert.deepEqual(stillActive.criteria, fresh.criteria);
    await rpc(trusted, 'brief.approve', { reviewedHash: revision.review.contentHash, expectedActiveHash: approved.active.identity.contentHash });
    const changed = await rpc(call, 'workflow.packet', { leadId, stage: 'assessment' });
    assert.notEqual(changed.inputHash, fresh.inputHash);
    assert.equal(changed.criteria.approvedSearchBrief.hardRequirements.length, 1);
    assert.deepEqual(await sql`SELECT id,decision,application_stage,notes FROM job_leads ORDER BY id`, humans);
    assert.deepEqual(await rpc(call, 'truth.list'), truth);
    await assert.rejects(rpc(call, 'workflow.save', { packetId: old.id, inputHash: old.inputHash, result: {} }), /Inputs changed/);
  } finally { await db.close(); }
});

test('preparation plans follow each job current durable stages, pending brief gates, and saved attempt limits', async () => {
  const { db, sql, call, trusted } = await setup();
  try {
    const leadId = await addVerified(call);
    const otherId = await addVerified(call, 'other');
    const plan = (id = leadId) => rpc(call, 'preparation.plan', { leadId: id });
    assert.equal((await plan()).nextAction, 'assess');
    await sql`UPDATE job_leads SET posting_source_note='' WHERE id=${leadId}`;
    assert.equal((await plan()).nextAction, 'verify_posting', 'verified text without source provenance is not ready');
    await rpc(call, 'draft.posting', leadId, POSTING, 'User verified this fictional original posting.');
    await rpc(trusted, 'brief.addMessage', MESSAGE);
    const draft = await rpc(call, 'brief.propose', { proposal: proposal(), expectedDraftHash: null });
    assert.equal((await plan()).nextAction, 'review_search_brief');
    const approved = await rpc(trusted, 'brief.approve', { reviewedHash: draft.review.contentHash, expectedActiveHash: null });
    const assessment = await assess(call, leadId);
    let current = await plan();
    assert.equal(current.nextAction, 'choose_job');
    assert.equal(current.stages.assessment.id, assessment.id);
    assert.deepEqual(current.approvedSearchBrief, approved.active.identity);
    assert.equal((await plan(otherId)).stages.assessment, null);
    assert.equal((await plan(otherId)).nextAction, 'assess');
    await rpc(call, 'leads.update', { id: leadId, decision: 'keep', verification: 'verified' });
    assert.equal((await plan()).nextAction, 'select_claims');
    const selection = await rpc(call, 'workflow.packet', { leadId, stage: 'selection' });
    assert.equal((await plan()).stages.selection.id, selection.id);
    assert.equal((await plan()).nextAction, 'select_claims');
    const result = { template: TEMPLATE_VERSION, sections: [{ kind: 'experience', claimIds: ['experience.1.claim.1'] }], outreach: false, unresolved: [] };
    assert.equal((await rpc(call, 'workflow.save', { packetId: selection.id, inputHash: selection.inputHash, result })).state, 'complete');
    assert.equal((await plan()).nextAction, 'build_materials');
    await sql`UPDATE job_work_stages SET result='{}'::jsonb WHERE id=${selection.id}`;
    const corrupt = await plan();
    assert.equal(corrupt.nextAction, 'needs_attention');
    assert.equal(corrupt.approvalRequired, true);
    assert.equal(corrupt.canResume, false);
    await sql`UPDATE job_work_stages SET result=${JSON.stringify(result)}::jsonb WHERE id=${selection.id}`;
    await rpc(call, 'brief.propose', { proposal: proposal('hard_requirement'), expectedDraftHash: null });
    assert.equal((await plan()).nextAction, 'build_materials', 'pending revision must not block the approved brief');
    await rpc(call, 'draft.posting', leadId, POSTING + 'Updated responsibilities.', 'User verified the changed fictional posting.');
    current = await plan();
    assert.equal(current.nextAction, 'assess');
    assert.equal(current.stages.assessment, null, 'historical completed assessment is not current');
    assert.equal(current.stages.selection, null, 'historical completed selection is not current');
    const fresh = await rpc(call, 'workflow.packet', { leadId, stage: 'assessment' });
    for (let attempt = 0; attempt < 2; attempt++) await rpc(call, 'workflow.save', { packetId: fresh.id, inputHash: fresh.inputHash, result: {} });
    current = await plan();
    assert.equal(current.nextAction, 'needs_attention');
    assert.equal(current.canResume, false);
    assert.equal(current.automaticSubmission, false);
    const before = await sql`SELECT id,state,attempts FROM job_work_stages ORDER BY id`;
    await plan();
    assert.deepEqual(await sql`SELECT id,state,attempts FROM job_work_stages ORDER BY id`, before, 'reading the plan never consumes repair attempts');
    await rpc(call, 'leads.update', { id: otherId, decision: 'pass' });
    assert.equal((await plan(otherId)).nextAction, 'skipped');
  } finally { await db.close(); }
});


test('MCP workflow tools expose brief reads and proposals but no user-message, cancellation or approval writes', async () => {
  const modulePath = './workflow-tools.mjs';
  const { workflowTools } = await import(modulePath);
  const calls: { method: string; args: unknown[] }[] = [];
  const tools = workflowTools(async (method: string, args: unknown[]) => { calls.push({ method, args }); });
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    await tool.run({});
  }
  assert.deepEqual(calls.filter(({ method }) => method.startsWith('brief.')).map(({ method }) => method).sort(),
    ['brief.propose', 'brief.read']);
  assert.ok(calls.some(({ method }) => method === 'preparation.plan'));
  for (const forbidden of ['brief.addMessage', 'brief.cancelDraft', 'brief.approve', 'draft.approve', 'truth.review']) {
    assert.ok(!calls.some(({ method }) => method === forbidden), `MCP must not expose ${forbidden}`);
  }
});


test('current material metadata and historical draft approval cannot hide missing résumé bytes', async () => {
  const { db, store, sql, call } = await setup();
  const root = await tempRoot('jobdesk-preparation-');
  Object.assign(store, { root });
  try {
    const leadId = await addVerified(call, 'missing-artifact');
    await rpc(call, 'leads.update', { id: leadId, decision: 'keep', verification: 'verified' });
    await assess(call, leadId);
    const selection = await rpc(call, 'workflow.packet', { leadId, stage: 'selection' });
    const result: Parameters<typeof makeMaterialManifest>[0] = { template: TEMPLATE_VERSION, sections: [{ kind: 'experience', claimIds: ['experience.1.claim.1'] }], outreach: false, unresolved: [] };
    assert.equal((await rpc(call, 'workflow.save', { packetId: selection.id, inputHash: selection.inputHash, result })).state, 'complete');
    const context = await store.run((sql) => workflowContext(leadId, sql));
    const manifest = makeMaterialManifest(result, context);
    const inputHash = materialFingerprint(manifest, context);
    const materialId = randomUUID();
    const artifactId = randomUUID();
    // Persist only metadata intentionally: no file exists at the bound path.
    // Neither a visual pass nor old approval establishes the current bytes.
    const artifacts = [{ id: artifactId, kind: 'resume', relativePath: `artifacts/${artifactId}.pdf`,
      url: `/api/jobs/artifacts/${artifactId}`, contentHash: 'a'.repeat(64) }];
    await sql`INSERT INTO job_material_manifests(id,lead_id,selection_id,input_hash,state,manifest,artifacts,validation,attempts)
      VALUES(${materialId},${leadId},${selection.id},${inputHash},'current',${JSON.stringify(manifest)}::jsonb,
        ${JSON.stringify(artifacts)}::jsonb,'{"visual":"passed"}'::jsonb,1)`;
    await sql`INSERT INTO job_application_drafts(lead_id,resume_variant,outreach,claim_ids,truth_snapshot,review_status,material_manifest_id)
      VALUES(${leadId},${manifest.claims.map((claim) => claim.claim).join('\n')},'',${manifest.claims.map((claim) => claim.id)},
        ${JSON.stringify(manifest.claims)}::jsonb,'approved',${materialId})`;
    const stagesBefore = await sql`SELECT id,state,attempts FROM job_work_stages ORDER BY id`;
    const plan = await rpc(call, 'preparation.plan', { leadId });
    assert.equal(plan.nextAction, 'needs_attention');
    assert.equal(plan.canResume, false);
    assert.equal(plan.approvalRequired, true);
    assert.equal(plan.automaticSubmission, false);
    assert.equal(plan.reviews, null);
    assert.equal(plan.stages.material.id, materialId);
    assert.match(plan.reason, /bytes or review inputs are unavailable/);
    assert.deepEqual(await sql`SELECT id,state,attempts FROM job_work_stages ORDER BY id`, stagesBefore,
      'reading a plan must not fabricate a review or consume an attempt');
    await rpc(call, 'leads.update', { id: leadId, decision: 'pass' });
    assert.equal((await rpc(call, 'preparation.plan', { leadId })).nextAction, 'skipped',
      'human pass still outranks the missing-artifact blocker');
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
