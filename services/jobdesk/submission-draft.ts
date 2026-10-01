import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '../../lib/job-storage';

export const draftBindingSchema = z.object({
  draftVersion: z.string().min(1).max(100),
  draftHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type DraftBinding = z.infer<typeof draftBindingSchema>;

export async function readSubmissionDraft(owner: string, itemId: string, sql: Sql) {
  const [draft] = await sql`SELECT d.id::text AS "draftId",d.updated_at::text AS "draftVersion",
    d.review_status AS "draftReviewStatus",d.resume_variant AS "resumeVariant",d.outreach,
    d.claim_ids AS "claimIds",d.truth_snapshot AS "truthSnapshot",
    (jsonb_array_length(d.truth_snapshot)>0 AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(d.truth_snapshot) s LEFT JOIN resume_truth_claims c ON c.id=s->>'id'
      WHERE c.id IS NULL OR c.review_status<>'reviewed' OR c.claim IS DISTINCT FROM s->>'claim'
        OR c.source_note IS DISTINCT FROM s->>'sourceNote' OR c.updated_at::text IS DISTINCT FROM s->>'version'
    )) AS "snapshotCurrent"
    FROM job_application_batch_items i JOIN job_application_drafts d ON d.lead_id=i.lead_id
    WHERE i.id=${itemId} AND i.owner_id=${owner}`;
  if (!draft) return null;
  const snapshot = {
    draftId: draft.draftId,
    resumeVariant: draft.resumeVariant,
    outreach: draft.outreach,
    claimIds: draft.claimIds,
    truthSnapshot: draft.truthSnapshot,
  };
  return {
    draftVersion: draft.draftVersion as string,
    draftHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    draftReviewStatus: draft.draftReviewStatus as string,
    snapshotCurrent: draft.snapshotCurrent as boolean,
    snapshot,
  };
}
