import type { Sql } from '../../lib/job-storage';
import { JobdeskError } from './errors';

/** Assistant activity and compact read models for the cockpit. Summaries are
 * structural only: counts, states and stage names, never claim or posting text. */
export type ActivityKind = 'read' | 'saved' | 'lease' | 'collect' | 'needs_you' | 'receipt' | 'error';
type Described = { kind: ActivityKind; summary: string; leadId?: string; itemId?: string; packetId?: string; manifestId?: string };

/** Calls that are not assistant work and would only add noise. */
const SILENT = new Set(['health', 'browser.open', 'owner.shutdown', 'cockpit.live']);
export const ACTIVITY_LIMIT = 2000;
const LEAD = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9-]{36}$/i;

const first = (args: unknown) => (Array.isArray(args) && args[0] && typeof args[0] === 'object' ? args[0] as Record<string, any> : {});
const str = (value: unknown, pattern: RegExp) => (typeof value === 'string' && pattern.test(value) ? value : undefined);
const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
const plural = (n: number, word: string) => `${n} ${n === 1 ? word : word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`}`;
const kb = (value: unknown) => `${(Buffer.byteLength(JSON.stringify(value ?? null)) / 1024).toFixed(1)} KB`;

export function describeCall(method: string, args: unknown, result: any): Described {
  const input = first(args);
  const leadId = str(input.leadId, LEAD) ?? (Array.isArray(args) ? str(args[0], LEAD) : undefined);
  const itemId = str(input.itemId, UUID);
  switch (method) {
    case 'items.claim': return { kind: 'lease', itemId, summary: 'Preparing. Lease claimed for 120 seconds.' };
    case 'items.renew': return { kind: 'lease', itemId, summary: 'Lease renewed for 120 seconds.' };
    case 'items.status': {
      const status = String(input.status ?? '');
      if (status === 'awaiting_approval') return { kind: 'needs_you', itemId, summary: 'Set to awaiting approval. Waiting for your review.' };
      if (status === 'blocked') return { kind: 'needs_you', itemId, summary: 'Set to blocked. Needs your attention.' };
      return { kind: 'saved', itemId, summary: status === 'skipped' ? 'Skipped this role.' : 'Preparation progress saved.' };
    }
    case 'submission.begin': return { kind: 'saved', itemId, summary: `Attempt bound to approved draft ${String(input.draftVersion ?? '').slice(0, 19)}.` };
    case 'submission.uncertain': return { kind: 'needs_you', itemId: str(result?.id, UUID), summary: 'Submission uncertain. Blocked for reconciliation.' };
    case 'submission.record': return { kind: 'receipt', itemId, summary: 'Receipt saved. Counted in weekly review.' };
    case 'workflow.packet': return { kind: 'read', leadId, summary: `${input.stage === 'selection' ? 'Selection' : 'Assessment'} packet, ${kb(result)}.` };
    case 'workflow.save': return { kind: 'saved', packetId: str(input.packetId, UUID),
      summary: input.result?.recommendation ? `Recommendation: ${String(input.result.recommendation)}. ${plural(count(input.result.reasons), 'reason')}, ${plural(count(input.result.uncertainties), 'uncertainty')}.`
        : Array.isArray(input.result?.sections) ? `Selection saved: ${plural(input.result.sections.length, 'section')}, ${plural(input.result.sections.reduce((n: number, s: any) => n + count(s?.claimIds), 0), 'claim ID')}.`
          : 'Work result saved.' };
    case 'workflow.claims': return { kind: 'read', summary: `Returned ${plural(count(result?.claims), 'approved claim')}.` };
    case 'workflow.sources': return { kind: 'read', summary: `Read sources for ${plural(count(result?.claims), 'claim')}.` };
    case 'workflow.posting': return { kind: 'read', leadId, summary: `Read posting segment at offset ${Number(input.offset ?? 0).toLocaleString('en-US')}.` };
    case 'workflow.savePosting': return { kind: 'saved', leadId, summary: 'Original posting saved, verified by the assistant.' };
    case 'workflow.status': return { kind: 'read', leadId, summary: `Read stage states: ${plural(count(result?.stages), 'stage')}, ${plural(count(result?.materials), 'material set')}.` };
    case 'workflow.jobs': return { kind: 'read', summary: `Listed ${plural(count(result?.jobs), 'job candidate')}.` };
    case 'workflow.build': return { kind: 'saved', leadId, summary: `Built materials: ${String(result?.state ?? 'pending').replace('_', ' ')}.` };
    case 'workflow.review': return { kind: input.passed ? 'saved' : 'needs_you', manifestId: str(input.id, UUID), summary: `Rendered review recorded: ${input.passed ? 'passed' : 'failed'}.` };
    case 'workflow.configure': return { kind: 'saved', summary: 'Search criteria saved.' };
    case 'collection.run': {
      const c = result?.counts ?? {};
      return { kind: 'collect', summary: `${input.source === 'feeds' ? 'Feeds' : 'Built In Chicago'}: ${Number(c.parsed ?? 0)} parsed · ${Number(c.failed ?? 0)} failed · ${Number(c.saved ?? 0)} saved.` };
    }
    case 'collection.status': return { kind: 'read', summary: `Read ${plural(count(result), 'collection run')}.` };
    case 'exclusions.list': return { kind: 'read', summary: `Listed ${plural(count(result?.exclusions), 'exclusion')}.` };
    case 'exclusions.restore': return { kind: 'saved', summary: 'Restored an excluded job.' };
    case 'truth.importResume': case 'truth.importText': case 'truth.addProject':
      return { kind: 'needs_you', summary: 'Résumé claims added. They need your review before use.' };
    case 'truth.list': return { kind: 'read', summary: `Read ${plural(count(result), 'résumé claim')}.` };
    case 'batches.list': return { kind: 'read', summary: `Listed ${count(result?.batches)} ${count(result?.batches) === 1 ? 'batch' : 'batches'}.` };
    case 'batches.items': return { kind: 'read', summary: `Listed ${plural(count(result?.items), 'batch item')}.` };
    case 'items.read': return { kind: 'read', itemId: Array.isArray(args) ? str(args[0], UUID) : undefined, summary: 'Read item, draft binding and attempts.' };
    case 'leads.import': return { kind: 'saved', summary: `Imported ${plural(count(Array.isArray(args) ? args[0] : []), 'lead')}.` };
    case 'leads.add': case 'leads.update': return { kind: 'saved', summary: 'Lead saved.' };
    case 'search.settings': case 'settings.read': return { kind: 'read', summary: 'Read settings.' };
    case 'search.run': return { kind: 'collect', summary: 'Scanned job search feeds.' };
    case 'draft.saveManual': return { kind: 'saved', summary: 'Draft saved from approved claims.' };
    default: return { kind: 'read', summary: `${method}.` };
  }
}

export async function recordActivity(sql: Sql, input: { tool?: string; method: string; args: unknown; result?: unknown; error?: unknown }) {
  if (SILENT.has(input.method)) return;
  const tool = typeof input.tool === 'string' && /^[a-z_]{1,64}$/.test(input.tool) ? input.tool : '';
  const described: Described = input.error
    ? { kind: 'error', summary: input.error instanceof JobdeskError ? `Rejected: ${input.error.code.toLowerCase().replaceAll('_', ' ')}.` : 'Rejected by the jobdesk.',
      ...(() => { const d = describeCall(input.method, input.args, undefined); return { leadId: d.leadId, itemId: d.itemId }; })() }
    : describeCall(input.method, input.args, input.result);
  const { itemId } = described;
  let { leadId } = described;
  if (!leadId && described.packetId) leadId = (await sql`SELECT lead_id FROM job_work_stages WHERE id=${described.packetId}`)[0]?.lead_id;
  if (!leadId && described.manifestId) leadId = (await sql`SELECT lead_id FROM job_material_manifests WHERE id=${described.manifestId}`)[0]?.lead_id;
  if (!leadId && itemId) leadId = (await sql`SELECT lead_id FROM job_application_batch_items WHERE id=${itemId}`)[0]?.lead_id;
  await sql`INSERT INTO jobdesk_activity(tool,method,ok,kind,summary,lead_id,item_id)
    VALUES(${tool},${input.method},${!input.error},${described.kind},${described.summary.slice(0, 300)},${leadId ?? null},${itemId ?? null})`;
  await sql`DELETE FROM jobdesk_activity WHERE id <= (SELECT max(id) - ${ACTIVITY_LIMIT} FROM jobdesk_activity)`;
}

/** Polled by the cockpit: recent activity, live leases and navigation counts. */
export async function liveState(sql: Sql) {
  const events = await sql`SELECT a.id::text AS id,a.at,a.tool,a.method,a.ok,a.kind,a.summary,a.lead_id AS "leadId",
      l.title,l.organization FROM jobdesk_activity a LEFT JOIN job_leads l ON l.id=a.lead_id ORDER BY a.id DESC LIMIT 40`;
  const leases = await sql`SELECT i.id AS "itemId",i.lead_id AS "leadId",l.title,l.organization,i.lease_expires_at AS "expiresAt",i.status
    FROM job_application_batch_items i JOIN job_leads l ON l.id=i.lead_id
    WHERE i.lease_expires_at>clock_timestamp() ORDER BY i.lease_expires_at DESC LIMIT 10`;
  const [counts] = await sql`SELECT
      (SELECT count(*)::int FROM job_leads WHERE decision='review') AS leads,
      (SELECT count(*)::int FROM resume_truth_claims WHERE review_status='unreviewed') AS truths,
      (SELECT count(*)::int FROM jobdesk_submission_attempts WHERE state IN ('pending','uncertain')) AS reconcile,
      (SELECT count(*)::int FROM job_application_batch_items WHERE status IN ('awaiting_approval','blocked')) AS today`;
  return { now: new Date().toISOString(), events, leases, counts, lastCallAt: events[0]?.at ?? null };
}

export const STAGES = ['Discovered', 'Assessed', 'Chosen', 'Materials', 'Approved', 'Submitted'] as const;

/** Every active lead placed on the six-step track from lead to receipt. */
export async function pipeline(sql: Sql) {
  const rows = await sql`SELECT l.id,l.title,l.organization,l.location,l.source,l.verification_status AS "verificationStatus",l.decision,
      l.application_stage AS "applicationStage",i.id AS "itemId",i.status AS "itemStatus",i.lease_expires_at AS "leaseExpiresAt",
      (i.lease_expires_at>clock_timestamp()) AS leased,d.review_status AS "draftStatus",(d.id IS NOT NULL) AS "hasDraft",
      a.result->>'recommendation' AS recommendation,s.state AS "selectionState",m.state AS "materialState",m.validation,r.confirmed_at AS "receiptAt"
    FROM job_leads l
    LEFT JOIN LATERAL (SELECT * FROM job_application_batch_items x WHERE x.lead_id=l.id ORDER BY x.updated_at DESC LIMIT 1) i ON true
    LEFT JOIN job_application_drafts d ON d.lead_id=l.id
    LEFT JOIN LATERAL (SELECT result FROM job_work_stages w WHERE w.lead_id=l.id AND w.stage='assessment' AND w.state='complete' ORDER BY w.updated_at DESC LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT state FROM job_work_stages w WHERE w.lead_id=l.id AND w.stage='selection' ORDER BY w.updated_at DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (SELECT state,validation FROM job_material_manifests mm WHERE mm.lead_id=l.id ORDER BY mm.created_at DESC LIMIT 1) m ON true
    LEFT JOIN job_application_receipts r ON r.item_id=i.id
    WHERE (l.decision<>'pass' OR i.id IS NOT NULL) AND l.application_stage IS DISTINCT FROM 'closed'
    ORDER BY l.updated_at DESC,l.id LIMIT 60`;
  const jobs = rows.map((row) => {
    const stage = row.receiptAt ? 5
      : row.draftStatus === 'approved' ? 4
        : row.materialState || row.hasDraft || ['preparing', 'awaiting_approval'].includes(row.itemStatus) ? 3
          : row.itemId || row.decision === 'keep' ? 2
            : row.recommendation ? 1 : 0;
    return { ...row, stage };
  });
  const [funnel] = await sql`SELECT (SELECT count(*)::int FROM job_leads) AS leads,
      (SELECT count(DISTINCT lead_id)::int FROM job_work_stages WHERE stage='assessment' AND state='complete') AS assessed,
      (SELECT count(DISTINCT lead_id)::int FROM job_application_batch_items) AS chosen,
      (SELECT count(*)::int FROM job_application_drafts WHERE review_status='approved') AS approved,
      (SELECT count(*)::int FROM job_application_receipts) AS receipts`;
  return { stages: STAGES, jobs, funnel };
}

/** Assessment reasons and the live lease for one lead's detail page. */
export async function leadView(leadId: string, sql: Sql) {
  const [assessment] = await sql`SELECT result,updated_at AS "savedAt" FROM job_work_stages
    WHERE lead_id=${leadId} AND stage='assessment' AND state='complete' ORDER BY updated_at DESC LIMIT 1`;
  const [lease] = await sql`SELECT id AS "itemId",lease_expires_at AS "expiresAt",status FROM job_application_batch_items
    WHERE lead_id=${leadId} AND lease_expires_at>clock_timestamp() LIMIT 1`;
  const [item] = await sql`SELECT id AS "itemId",status FROM job_application_batch_items WHERE lead_id=${leadId} ORDER BY updated_at DESC LIMIT 1`;
  return { assessment: assessment ? { ...assessment.result, savedAt: assessment.savedAt } : null, lease: lease ?? null, item: item ?? null };
}

/** Attempts that need a human outcome, plus reconciled items awaiting a deliberate requeue. */
export async function reconciliation(sql: Sql) {
  const attempts = await sql`SELECT a.id AS "attemptId",a.state,a.note,a.draft_version AS "draftVersion",a.draft_hash AS "draftHash",
      a.created_at AS "createdAt",a.updated_at AS "updatedAt",i.id AS "itemId",i.status AS "itemStatus",l.id AS "leadId",l.title,l.organization,l.location
    FROM jobdesk_submission_attempts a JOIN job_application_batch_items i ON i.id=a.item_id JOIN job_leads l ON l.id=i.lead_id
    WHERE a.state IN ('pending','uncertain') OR (a.state='not_submitted' AND i.status='blocked'
      AND NOT EXISTS(SELECT 1 FROM jobdesk_submission_attempts b WHERE b.item_id=a.item_id AND b.state IN ('pending','uncertain','confirmed')))
    ORDER BY a.updated_at DESC LIMIT 20`;
  const log = attempts.length ? await sql`SELECT id::text AS id,at,tool,method,kind,summary,item_id AS "itemId" FROM jobdesk_activity
    WHERE item_id = ANY(${attempts.map((a) => a.itemId)}::uuid[]) ORDER BY id DESC LIMIT 60` : [];
  return { attempts: attempts.map((attempt) => ({ ...attempt, log: log.filter((event) => event.itemId === attempt.itemId).slice(0, 8).reverse() })) };
}
