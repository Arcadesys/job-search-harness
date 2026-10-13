import { z } from 'zod';
import type { Sql } from '../../lib/job-storage';
import { listResumeTruth } from '../../lib/resume-truth';

export const manualDraftSchema = z.object({
  leadId: z.string().regex(/^[a-f0-9]{64}$/),
  resumeVariant: z.string().trim().min(1).max(12000),
  outreach: z.string().max(3000),
  claimIds: z.array(z.string().min(1).max(160)).min(1).max(200),
}).strict();

/** Save human-prepared materials, without claiming a model assessment or approval.
 * The owner calls this inside its transaction; snapshots come from current truths.
 */
export async function saveManualDraft(raw: z.infer<typeof manualDraftSchema>, sql: Sql) {
  const input = manualDraftSchema.parse(raw);
  const [lead] = await sql`SELECT verification_status,posting_text,posting_source_note,application_stage,decision
    FROM job_leads WHERE id=${input.leadId} FOR UPDATE`;
  if (!lead || lead.verification_status !== 'verified' || String(lead.posting_text ?? '').trim().length < 200
    || String(lead.posting_source_note ?? '').trim().length < 8)
    throw new Error('A verified original posting is required before saving a manual draft.');
  const attempts = await sql`SELECT a.id FROM jobdesk_submission_attempts a
    JOIN job_application_batch_items i ON i.id=a.item_id WHERE i.lead_id=${input.leadId}
    AND a.state IN ('pending','uncertain','confirmed')`;
  if (lead.decision === 'pass' || ['applied','interviewing','offer','closed'].includes(String(lead.application_stage)) || attempts.length)
    throw new Error('Lead is passed, already applied, or requires submission reconciliation.');
  const claimIds = [...new Set(input.claimIds)];
  const current = await listResumeTruth(sql);
  const snapshot = claimIds.map((id) => current.find((claim) => claim.id === id && claim.reviewStatus === 'reviewed'));
  if (snapshot.some((claim) => !claim)) throw new Error('Every selected truth must exist and be reviewed.');
  const [draft] = await sql`INSERT INTO job_application_drafts(lead_id,resume_variant,outreach,claim_ids,truth_snapshot,review_status)
    VALUES(${input.leadId},${input.resumeVariant},${input.outreach},${claimIds},${JSON.stringify(snapshot)}::jsonb,'review_required')
    ON CONFLICT(lead_id) DO UPDATE SET resume_variant=EXCLUDED.resume_variant,outreach=EXCLUDED.outreach,
      claim_ids=EXCLUDED.claim_ids,truth_snapshot=EXCLUDED.truth_snapshot,review_status='review_required',updated_at=clock_timestamp()
    RETURNING updated_at::text AS version,review_status AS "reviewStatus"`;
  await sql`UPDATE jobdesk_artifacts SET approval_state='superseded' WHERE lead_id=${input.leadId}`;
  return draft;
}
