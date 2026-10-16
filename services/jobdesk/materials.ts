import { createHash, randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fontDirectory } from '../../lib/resources';
import { renderResumeDocument } from '../../lib/resume-document';
import { renderApplicationPdf } from '../../lib/job-pdf';
import { makeMaterialManifest, materialFingerprint, refreshWorkflow, selectionSchema, verifyArtifactFiles, type MaterialManifest } from '../../lib/job-workflow';
import { parameterizedSql, type Sql } from '../../lib/job-storage';
import type { JobdeskStore } from './store';
import { JobdeskError } from './errors';

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
async function saveManifestDraft(leadId: string, id: string, manifest: MaterialManifest, sql: Sql) {
  const resumeVariant = manifest.sections.map((section) => `${section.heading}\n${section.lines.join('\n')}`).join('\n\n');
  const [draft] = await sql`INSERT INTO job_application_drafts(lead_id,resume_variant,outreach,claim_ids,truth_snapshot,review_status,material_manifest_id)
    VALUES(${leadId},${resumeVariant},${manifest.outreach},${manifest.claims.map((c) => c.id)},${JSON.stringify(manifest.claims)}::jsonb,'review_required',${id})
    ON CONFLICT(lead_id) DO UPDATE SET resume_variant=EXCLUDED.resume_variant,outreach=EXCLUDED.outreach,claim_ids=EXCLUDED.claim_ids,
      truth_snapshot=EXCLUDED.truth_snapshot,review_status='review_required',material_manifest_id=EXCLUDED.material_manifest_id,updated_at=clock_timestamp()
    RETURNING updated_at::text AS version`;
  await sql`UPDATE jobdesk_artifacts SET approval_state='superseded' WHERE lead_id=${leadId}`;
  await sql`UPDATE job_material_manifests SET state='stale',updated_at=clock_timestamp() WHERE lead_id=${leadId} AND id<>${id} AND state='current'`;
  return draft;
}
export async function buildMaterials(leadId: string, store: JobdeskStore, repair = false) {
  const snapshot = await store.run(async (sql) => {
    const context = await refreshWorkflow(leadId, sql);
    if (context.lead.verificationStatus !== 'verified' || !context.lead.postingText || !context.lead.postingSourceNote)
      throw new JobdeskError('WORKFLOW_REJECTED', 'Verify the original posting before building materials.');
    if (context.lead.decision === 'pass' || ['applied', 'interviewing', 'offer', 'closed'].includes(context.lead.applicationStage))
      throw new JobdeskError('WORKFLOW_REJECTED', 'This job is passed or already applied.');
    const attempts = await sql`SELECT a.id FROM jobdesk_submission_attempts a JOIN job_application_batch_items i ON i.id=a.item_id
      WHERE i.lead_id=${leadId} AND a.state IN ('pending','uncertain','confirmed')`;
    if (attempts.length) throw new JobdeskError('SUBMISSION_RECONCILIATION_REQUIRED', 'Reconcile the existing submission before preparing new materials.');
    const [selection] = await sql`SELECT * FROM job_work_stages WHERE lead_id=${leadId} AND stage='selection' AND input_hash=${context.selectionHash} AND state='complete'`;
    if (!selection) throw new JobdeskError('STALE_WORK', 'Save a current claim selection before building materials.');
    const manifest = makeMaterialManifest(selectionSchema.parse(selection.result), context);
    const inputHash = materialFingerprint(manifest, context);
    const [prior] = await sql`SELECT * FROM job_material_manifests WHERE lead_id=${leadId} AND input_hash=${inputHash}`;
    if (prior && ['current','stale'].includes(prior.state) && !repair) {
      try {
        await verifyArtifactFiles(prior.artifacts, store.root);
        const [bound] = await sql`SELECT material_manifest_id FROM job_application_drafts WHERE lead_id=${leadId}`;
        if (prior.state !== 'current' || bound?.material_manifest_id !== prior.id) {
          await store.db.transaction(async (tx) => {
            const transactional = parameterizedSql(tx);
            const draft = await saveManifestDraft(leadId, prior.id, prior.manifest, transactional);
            await transactional`UPDATE job_material_manifests SET state='current',updated_at=clock_timestamp() WHERE id=${prior.id}`;
            for (const artifact of prior.artifacts) await transactional`UPDATE jobdesk_artifacts SET approval_state='review_required',draft_version=${draft.version} WHERE id=${artifact.id}`;
          });
        }
        return { reused: true as const, prior: { ...prior, state: 'current' } };
      }
      catch (error) { await sql`UPDATE job_material_manifests SET state='needs_attention',error=${(error as Error).message} WHERE id=${prior.id}`;
        return { reused: true as const, prior: { ...prior, state: 'needs_attention', error: (error as Error).message } }; }
    }
    if (prior?.state === 'pending') throw new JobdeskError('WORKFLOW_REJECTED', 'Materials are already being built.');
    if (prior && (!repair || prior.attempts >= 2)) return { reused: true as const, prior };
    const id = prior?.id ?? randomUUID();
    await sql`INSERT INTO job_material_manifests(id,lead_id,selection_id,input_hash,state,manifest,attempts)
      VALUES(${id},${leadId},${selection.id},${inputHash},'pending',${JSON.stringify(manifest)}::jsonb,1)
      ON CONFLICT(lead_id,input_hash) DO UPDATE SET state='pending',attempts=job_material_manifests.attempts+1,error='',updated_at=clock_timestamp()`;
    return { reused: false as const, id, manifest, inputHash, context, selectionId: selection.id };
  });
  if (snapshot.reused) return { ...snapshot.prior, inputHash: snapshot.prior.input_hash,
    artifacts: snapshot.prior.artifacts.map((artifact: any) => ({ ...artifact, path: path.join(store.root, artifact.relativePath) })), reused: true };
  const files: string[] = [];
  try {
    const resume = await renderResumeDocument(snapshot.manifest, snapshot.context.settings.links);
    const review = await renderApplicationPdf(snapshot.context.lead as Parameters<typeof renderApplicationPdf>[0], {
      resumeVariant: snapshot.manifest.sections.map((section) => `${section.heading}\n${section.lines.join('\n')}`).join('\n\n'),
      outreach: snapshot.manifest.outreach, truthSnapshot: snapshot.manifest.claims,
    }, fontDirectory());
    const rendered = [{ kind: 'resume', bytes: resume.bytes }, { kind: 'review', bytes: review }];
    if (snapshot.manifest.outreach) rendered.push({ kind: 'outreach', bytes: (await renderResumeDocument(snapshot.manifest, [], true)).bytes });
    const artifacts: { id: string; kind: string; relativePath: string; contentHash: string; url: string }[] = [];
    for (const item of rendered) {
      const id = randomUUID(), relativePath = `artifacts/${id}.pdf`;
      const absolutePath = path.join(store.root, relativePath);
      await writeFile(absolutePath, item.bytes, { flag: 'wx', mode: 0o600 }); files.push(absolutePath);
      artifacts.push({ id, kind: item.kind, relativePath, contentHash: hash(item.bytes), url: `/artifacts/${id}` });
    }
    return await store.run((_sql) => store.db.transaction(async (tx) => {
      const transactional = parameterizedSql(tx);
      const current = await refreshWorkflow(leadId, transactional);
      const [selection] = await transactional`SELECT id FROM job_work_stages WHERE lead_id=${leadId}
        AND stage='selection' AND state='complete' AND input_hash=${current.selectionHash}`;
      if (materialFingerprint(snapshot.manifest, current) !== snapshot.inputHash || selection?.id !== snapshot.selectionId
        || current.lead.verificationStatus !== 'verified' || current.lead.decision === 'pass'
        || ['applied', 'interviewing', 'offer', 'closed'].includes(current.lead.applicationStage))
        throw new JobdeskError('STALE_WORK', 'Material inputs changed during rendering. Read a fresh packet.');
      const draft = await saveManifestDraft(leadId, snapshot.id, snapshot.manifest, transactional);
      for (const artifact of artifacts) await transactional`INSERT INTO jobdesk_artifacts(id,lead_id,relative_path,content_hash,draft_version,claim_versions,kind)
        VALUES(${artifact.id},${leadId},${artifact.relativePath},${artifact.contentHash},${draft.version},${JSON.stringify(snapshot.manifest.claims)}::jsonb,${artifact.kind})`;
      const validation = { ...resume.validation, text: undefined };
      await transactional`UPDATE job_material_manifests SET state='current',artifacts=${JSON.stringify(artifacts)}::jsonb,
        validation=${JSON.stringify(validation)}::jsonb,error='',updated_at=clock_timestamp() WHERE id=${snapshot.id}`;
      return { id: snapshot.id, state: 'current', inputHash: snapshot.inputHash, draftVersion: draft.version,
        artifacts: artifacts.map((artifact) => ({ ...artifact, path: path.join(store.root, artifact.relativePath) })), validation, reused: false };
    }));
  } catch (error) {
    await Promise.all(files.map((file) => rm(file, { force: true })));
    await store.run((sql) => sql`UPDATE job_material_manifests SET state='needs_attention',error=${error instanceof Error ? error.message : 'Rendering failed.'},updated_at=clock_timestamp() WHERE id=${snapshot.id}`);
    if (error instanceof JobdeskError) throw error;
    return { id: snapshot.id, state: 'needs_attention', error: error instanceof Error ? error.message : 'Rendering failed.', repairRemaining: 1 };
  }
}

export async function reviewMaterials(input: { id: string; inputHash: string; passed: boolean; note: string }, sql: Sql, root: string) {
  const [row] = await sql`SELECT * FROM job_material_manifests WHERE id=${input.id}`;
  if (!row) throw new JobdeskError('WORKFLOW_REJECTED', 'Materials not found.');
  const context = await refreshWorkflow(row.lead_id, sql);
  const [draft] = await sql`SELECT material_manifest_id FROM job_application_drafts WHERE lead_id=${row.lead_id}`;
  if (row.input_hash !== input.inputHash || materialFingerprint(row.manifest, context) !== row.input_hash
    || draft?.material_manifest_id !== row.id || !['current', 'needs_attention'].includes(row.state))
    throw new JobdeskError('STALE_WORK', 'Materials changed. Review the current files.');
  if (!row.artifacts.length || row.validation.content !== 'passed' || row.validation.bounds !== 'passed')
    throw new JobdeskError('WORKFLOW_REJECTED', 'Build and validate the documents before visual review.');
  await verifyArtifactFiles(row.artifacts, root);
  const validation = { ...row.validation, visual: input.passed ? 'passed' : 'failed', reviewNote: input.note, reviewedAt: new Date().toISOString() };
  await sql`UPDATE job_material_manifests SET validation=${JSON.stringify(validation)}::jsonb,state=${input.passed ? 'current' : 'needs_attention'},updated_at=clock_timestamp() WHERE id=${input.id}`;
  if (!input.passed) await sql`UPDATE job_application_drafts SET review_status='review_required' WHERE material_manifest_id=${input.id}`;
  return { id: input.id, state: input.passed ? 'current' : 'needs_attention', validation };
}
