import type { Sql } from '../../lib/job-storage';
import { refreshWorkflow, makeMaterialManifest, materialFingerprint } from '../../lib/job-workflow';
import { readBriefState } from '../../lib/search-brief-store';
import { planPreparation } from '../../lib/preparation-plan';

/** A resumable read model over existing durable stages, not a second queue or
 * executor. This method never calls a provider, renders, collects or submits. */
export async function preparationPlan(leadId: string, sql: Sql) {
  const context = await refreshWorkflow(leadId, sql);
  const [attempt] = await sql`SELECT a.state FROM jobdesk_submission_attempts a
    JOIN job_application_batch_items i ON i.id=a.item_id WHERE i.lead_id=${leadId}
    AND a.state IN ('pending','uncertain','confirmed')
    ORDER BY CASE a.state WHEN 'uncertain' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END LIMIT 1`;
  const [assessment] = await sql`SELECT id,state,attempts FROM job_work_stages
    WHERE lead_id=${leadId} AND stage='assessment' AND input_hash=${context.assessmentHash}`;
  const [selection] = await sql`SELECT id,state,attempts,result FROM job_work_stages
    WHERE lead_id=${leadId} AND stage='selection' AND input_hash=${context.selectionHash}`;
  const [draft] = await sql`SELECT review_status,material_manifest_id FROM job_application_drafts WHERE lead_id=${leadId}`;
  let material;
  let materialBlocker: string | undefined;
  if (selection?.state === 'complete') {
    let manifest;
    try { manifest = makeMaterialManifest(selection.result, context); }
    catch { materialBlocker = 'The saved selection cannot produce materials. Resolve required claims or unresolved information and revise the selection.'; }
    if (manifest) {
      const expectedHash = materialFingerprint(manifest, context);
      const [row] = await sql`SELECT id,state,attempts,validation FROM job_material_manifests
        WHERE lead_id=${leadId} AND input_hash=${expectedHash}`;
      if (row) material = { id: row.id, state: row.state === 'current' && draft?.material_manifest_id !== row.id ? 'stale' : row.state,
        attempts: row.attempts, visual: row.validation?.visual };
    }
  }
  const brief = await readBriefState(sql);
  const plan = planPreparation({ lead: { decision: context.lead.decision, applicationStage: context.lead.applicationStage,
    verified: context.lead.verificationStatus === 'verified' && Boolean(context.lead.postingText && context.lead.postingSourceNote) },
    attemptState: attempt?.state, activeBrief: Boolean(brief.active), pendingBrief: Boolean(brief.draft),
    assessment: assessment ? { id: String(assessment.id), state: String(assessment.state), attempts: Number(assessment.attempts) } : undefined,
    selection: selection ? { id: String(selection.id), state: String(selection.state), attempts: Number(selection.attempts) } : undefined, material, materialBlocker,
    draftApproved: draft?.review_status === 'approved' && Boolean(material && draft.material_manifest_id === material.id) });
  return { leadId, ...plan, approvedSearchBrief: brief.active?.identity ?? null,
    stages: { assessment: assessment ? { id: assessment.id, state: assessment.state } : null,
      selection: selection ? { id: selection.id, state: selection.state } : null,
      material: material ? { id: material.id, state: material.state } : null } };
}
