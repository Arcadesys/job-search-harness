import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderApplicationPdf } from '../../lib/job-pdf';
import type { Sql } from '../../lib/job-storage';
import { getDraftingLead, listDraftingHistory } from '../../lib/job-drafting';

export async function createReviewPacket(root: string, leadId: string, sql: Sql) {
  const lead = await getDraftingLead(leadId, sql);
  const history = await listDraftingHistory(leadId, sql);
  if (!lead || !history.draft) throw new Error('A saved draft is required.');
  const draft = history.draft;
  const pdf = await renderApplicationPdf(
    lead as Parameters<typeof renderApplicationPdf>[0],
    draft as Parameters<typeof renderApplicationPdf>[1],
    fileURLToPath(new URL('../../assets/fonts/', import.meta.url)),
  );
  const id = randomUUID();
  const relative = `artifacts/${id}.pdf`;
  await writeFile(path.join(root, relative), pdf, { mode: 0o600, flag: 'wx' });
  const rows =
    await sql`INSERT INTO jobdesk_artifacts(id,lead_id,relative_path,content_hash,draft_version,claim_versions)
    SELECT ${id},${leadId},${relative},${createHash('sha256').update(pdf).digest('hex')},updated_at::text,truth_snapshot
    FROM job_application_drafts WHERE lead_id=${leadId} RETURNING id,relative_path AS "relativePath",content_hash AS "contentHash",approval_state AS "approvalState"`;
  return rows[0];
}
