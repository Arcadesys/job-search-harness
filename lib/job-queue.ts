import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { canAccessJobs, configuredGithubAccountIds } from '@/lib/jobs-access';

type Sql = NeonQueryFunction<false, false>;
export const BATCH_ITEM_STATUSES = ['queued', 'preparing', 'awaiting_approval', 'submitted', 'blocked', 'skipped'] as const;
export type BatchItemStatus = typeof BATCH_ITEM_STATUSES[number];

function db(): Sql {
  const url = process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Private job database is not configured.');
  return neon(url);
}

export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newMcpToken(): { token: string; id: string } {
  return { token: `jobdesk_${randomBytes(32).toString('base64url')}`, id: randomUUID() };
}

export function bearerToken(request: Request): string | null {
  const value = request.headers.get('authorization') ?? '';
  const match = /^Bearer (jobdesk_[A-Za-z0-9_-]{43})$/.exec(value);
  return match?.[1] ?? null;
}

export function validBatchStatus(value: unknown): value is BatchItemStatus {
  return typeof value === 'string' && (BATCH_ITEM_STATUSES as readonly string[]).includes(value);
}

export async function issueMcpToken(ownerId: string, label: string, sql: Sql = db()) {
  const { token, id } = newMcpToken();
  const cleanLabel = label.trim().slice(0, 80) || 'Local job-hunt MCP';
  const rows = await sql`INSERT INTO job_mcp_tokens (id,owner_id,label,token_hash,expires_at)
    VALUES (${id},${ownerId},${cleanLabel},${hashMcpToken(token)},now()+interval '90 days')
    RETURNING id,label,expires_at AS "expiresAt",created_at AS "createdAt"`;
  return { metadata: rows[0], token };
}

export async function listMcpTokens(ownerId: string, sql: Sql = db()) {
  return await sql`SELECT id,label,expires_at AS "expiresAt",expires_at<=now() AS expired,revoked_at AS "revokedAt",created_at AS "createdAt"
    FROM job_mcp_tokens WHERE owner_id=${ownerId} ORDER BY created_at DESC`;
}

export async function revokeMcpToken(ownerId: string, id: string, sql: Sql = db()) {
  await sql`UPDATE job_mcp_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE owner_id=${ownerId} AND id=${id}`;
}

export async function authenticateMcpToken(token: string, sql: Sql = db(), allowlist = configuredGithubAccountIds()): Promise<string | null> {
  const rows = await sql`SELECT owner_id AS "ownerId" FROM job_mcp_tokens
    WHERE token_hash=${hashMcpToken(token)} AND revoked_at IS NULL AND expires_at>now() LIMIT 1`;
  const ownerId = rows[0]?.ownerId;
  return typeof ownerId === 'string' && canAccessJobs(ownerId, allowlist) ? ownerId : null;
}

export async function createApplicationBatch(ownerId: string, leadIds: string[], sql: Sql = db()) {
  const selected = [...new Set(leadIds.filter((id) => /^[a-f0-9]{64}$/.test(id)))];
  if (!selected.length || selected.length > 30) throw new Error('Select between 1 and 30 pursued leads.');
  const id = randomUUID();
  const values = JSON.stringify(selected);
  const rows = await sql`WITH eligible AS (
      SELECT l.id AS lead_id FROM job_leads l
      JOIN jsonb_array_elements_text(${values}::jsonb) AS requested(id) ON requested.id=l.id
      WHERE l.decision='keep'
        AND NOT EXISTS (
          SELECT 1 FROM job_application_batch_items previous
          WHERE previous.owner_id=${ownerId} AND previous.lead_id=l.id
            AND previous.status IN ('queued','preparing','awaiting_approval','submitted')
        )
    ), created AS (
      INSERT INTO job_application_batches (id,owner_id)
      SELECT ${id},${ownerId} WHERE EXISTS (SELECT 1 FROM eligible)
      RETURNING id
    ), inserted AS (
      INSERT INTO job_application_batch_items (id,batch_id,owner_id,lead_id,status)
        SELECT gen_random_uuid(),created.id,${ownerId},eligible.lead_id,'queued'
        FROM created CROSS JOIN eligible
        RETURNING batch_id
    ), selected AS (
      INSERT INTO job_application_batch_selections (owner_id,batch_id)
        SELECT ${ownerId},created.id FROM created
      ON CONFLICT (owner_id) DO UPDATE SET batch_id=EXCLUDED.batch_id,selected_at=now()
      RETURNING batch_id
    ) SELECT batch_id AS "batchId" FROM inserted`;
  if (!rows.length) throw new Error('No selected leads are eligible. Existing active or submitted applications cannot be queued again.');
  return { id, count: rows.length };
}

export async function listApplicationBatches(ownerId: string, sql: Sql = db()) {
  return await sql`SELECT b.id,(s.batch_id=b.id) AS "isSelected",b.created_at AS "createdAt",COUNT(i.id)::int AS "itemCount",
      COUNT(*) FILTER (WHERE i.status='queued')::int AS queued,
      COUNT(*) FILTER (WHERE i.status='preparing')::int AS preparing,
      COUNT(*) FILTER (WHERE i.status='awaiting_approval')::int AS "awaitingApproval",
      COUNT(*) FILTER (WHERE i.status='submitted')::int AS submitted,
      COUNT(*) FILTER (WHERE i.status='blocked')::int AS blocked,
      COUNT(*) FILTER (WHERE i.status='skipped')::int AS skipped
    FROM job_application_batches b LEFT JOIN job_application_batch_items i ON i.batch_id=b.id AND i.owner_id=b.owner_id
    LEFT JOIN job_application_batch_selections s ON s.owner_id=b.owner_id
    WHERE b.owner_id=${ownerId} GROUP BY b.id,s.batch_id ORDER BY (s.batch_id=b.id) DESC,b.created_at DESC LIMIT 50`;
}

export async function selectApplicationBatch(ownerId: string, batchId: string, sql: Sql = db()) {
  const rows = await sql`INSERT INTO job_application_batch_selections (owner_id,batch_id)
    SELECT ${ownerId},b.id FROM job_application_batches b WHERE b.id=${batchId} AND b.owner_id=${ownerId}
    ON CONFLICT (owner_id) DO UPDATE SET batch_id=EXCLUDED.batch_id,selected_at=now()
    RETURNING batch_id AS id`;
  return rows[0] ?? null;
}

export async function listEligiblePursuedLeads(ownerId: string, sql: Sql = db()) {
  return await sql`SELECT l.id,l.title,l.organization FROM job_leads l
    WHERE l.decision='keep' AND NOT EXISTS (
      SELECT 1 FROM job_application_batch_items i
      WHERE i.owner_id=${ownerId} AND i.lead_id=l.id AND i.status IN ('queued','preparing','awaiting_approval','submitted')
    ) ORDER BY l.discovered_at DESC LIMIT 500`;
}

export async function listApplicationBatchItems(ownerId: string, batchId: string, sql: Sql = db()) {
  return await sql`SELECT i.id AS "itemId",i.lead_id AS "leadId",i.status,i.note,i.created_at AS "createdAt",i.updated_at AS "updatedAt",
      l.title,l.organization,l.location,l.source_url AS "sourceUrl",l.verification_status AS "verificationStatus",l.decision
    FROM job_application_batches b JOIN job_application_batch_items i ON i.batch_id=b.id AND i.owner_id=b.owner_id
    JOIN job_leads l ON l.id=i.lead_id WHERE b.id=${batchId} AND b.owner_id=${ownerId}
    ORDER BY i.created_at,i.id`;
}

export async function readApplicationBatchItem(ownerId: string, itemId: string, sql: Sql = db()) {
  const items = await sql`SELECT i.id AS "itemId",i.batch_id AS "batchId",i.lead_id AS "leadId",i.status,i.note,
      l.title,l.organization,l.location,l.source_url AS "sourceUrl",l.snippet,l.posting_text AS "postingText",
      l.posting_source_note AS "postingSourceNote",l.verification_status AS "verificationStatus",l.decision,
      d.resume_variant AS "resumeVariant",d.outreach,d.claim_ids AS "claimIds",d.truth_snapshot AS "truthSnapshot"
    FROM job_application_batch_items i JOIN job_leads l ON l.id=i.lead_id
    LEFT JOIN job_application_drafts d ON d.lead_id=l.id
    WHERE i.id=${itemId} AND i.owner_id=${ownerId} LIMIT 1`;
  if (!items[0]) return null;
  const truths = await sql`SELECT id,claim,source_note AS "sourceNote" FROM resume_truth_claims
    WHERE review_status='reviewed' ORDER BY id`;
  return { ...items[0], reviewedTruths: truths };
}

export async function updateApplicationBatchItem(ownerId: string, itemId: string, status: BatchItemStatus, note: string, sql: Sql = db()) {
  if (status === 'submitted') throw new Error('Record a confirmed submission with the receipt endpoint.');
  const rows = await sql`UPDATE job_application_batch_items i SET status=${status},note=${note.slice(0,1000)},updated_at=now()
    WHERE i.id=${itemId} AND i.owner_id=${ownerId} AND i.status<>'submitted'
    RETURNING i.id,i.status,i.note,i.updated_at AS "updatedAt"`;
  return rows[0] ?? null;
}

export async function recordApplicationReceipt(ownerId: string, itemId: string, input: {
  idempotencyKey: string; confirmation: string; confirmationUrl?: string;
}, sql: Sql = db()) {
  const idempotencyKey = input.idempotencyKey.trim();
  const confirmation = input.confirmation.trim();
  const confirmationUrl = input.confirmationUrl?.trim() ?? '';
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey) || !confirmation || confirmation.length > 1000 || confirmationUrl.length > 2000) {
    throw new Error('Provide an idempotency key and concise submission confirmation.');
  }
  if (confirmationUrl) {
    const url = new URL(confirmationUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Confirmation link must use HTTP or HTTPS.');
  }
  const rows = await sql`WITH owned AS (
      SELECT i.id,i.lead_id FROM job_application_batch_items i
      WHERE i.id=${itemId} AND i.owner_id=${ownerId}
    ), saved AS (
      INSERT INTO job_application_receipts (id,item_id,owner_id,idempotency_key,confirmation,confirmation_url,confirmed_at)
      SELECT gen_random_uuid(),owned.id,${ownerId},${idempotencyKey},${confirmation},${confirmationUrl},now() FROM owned
      ON CONFLICT (item_id) DO NOTHING
      RETURNING item_id,id,idempotency_key,confirmation,confirmation_url,confirmed_at
    ), existing AS (
      SELECT r.item_id,r.id,r.idempotency_key,r.confirmation,r.confirmation_url,r.confirmed_at
      FROM job_application_receipts r JOIN owned ON owned.id=r.item_id
      WHERE r.owner_id=${ownerId} AND r.idempotency_key=${idempotencyKey}
        AND NOT EXISTS (SELECT 1 FROM saved)
    ), chosen AS (
      SELECT * FROM saved UNION ALL SELECT * FROM existing
    ), event AS (
      INSERT INTO job_review_events (lead_id,event_type,occurred_on,note)
      SELECT owned.lead_id,'application',(chosen.confirmed_at AT TIME ZONE 'America/Chicago')::date,
        'Browser confirmation recorded by the local job-hunt workflow.'
      FROM owned JOIN chosen ON chosen.item_id=owned.id
      JOIN saved ON saved.item_id=owned.id
      ON CONFLICT (lead_id,event_type,occurred_on) DO NOTHING
      RETURNING lead_id
    ), updated AS (
      UPDATE job_application_batch_items i SET status='submitted',note='Submission confirmation recorded.',updated_at=now()
      FROM owned,chosen WHERE i.id=owned.id AND i.owner_id=${ownerId}
      RETURNING i.id AS "itemId",i.lead_id AS "leadId"
    )
    UPDATE job_leads l SET application_stage='applied',updated_at=now()
    FROM updated,chosen WHERE l.id=updated."leadId"
    RETURNING updated."itemId",chosen.id AS "receiptId",chosen.idempotency_key AS "idempotencyKey",
      chosen.confirmation,chosen.confirmation_url AS "confirmationUrl",chosen.confirmed_at AS "confirmedAt"`;
  if (!rows[0]) throw new Error('Submission could not be recorded. Check ownership and the idempotency key.');
  return rows[0];
}
