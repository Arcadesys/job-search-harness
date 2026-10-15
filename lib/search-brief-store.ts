import { z } from 'zod';
import { fingerprint, payloadBytes } from './workflow-hash';
import { type Sql } from './job-storage';
import { proposeSearchBrief, reviewSearchBrief, approveSearchBrief, compileSearchBrief, searchBriefProposalSchema,
  type SearchBriefDraft, type SearchBriefProposal } from './search-brief';
import { JobdeskError } from '../services/jobdesk/errors';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const briefMessageSchema = z.object({ id: z.string().min(1).max(160), text: z.string().trim().min(1).max(12000) }).strict();
export const briefProposeSchema = z.object({ proposal: searchBriefProposalSchema, expectedDraftHash: hash.nullable() }).strict();
export const briefApproveSchema = z.object({ reviewedHash: hash, expectedActiveHash: hash.nullable() }).strict();
export const briefCancelSchema = z.object({ expectedDraftHash: hash }).strict();
const rejected = (message: string): never => { throw new JobdeskError('WORKFLOW_REJECTED', message); };

/** Call writes inside the owner's serialized transaction. User messages and
 * approvals may only enter from its authenticated, CSRF-protected browser path. */
export async function appendBriefMessage(raw: z.infer<typeof briefMessageSchema>, sql: Sql) {
  const input = briefMessageSchema.parse(raw);
  const [prior] = await sql`SELECT text FROM job_search_brief_messages WHERE id=${input.id}`;
  if (prior) {
    if (prior.text !== input.text) rejected('Message ID already has different text. Create a new message.');
    return { id: input.id, reused: true };
  }
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM job_search_brief_messages`;
  if (count >= 100) rejected('The intake has reached its 100-message limit.');
  await sql`INSERT INTO job_search_brief_messages(id,text) VALUES(${input.id},${input.text})`;
  return { id: input.id, reused: false };
}
export async function readActiveSearchBrief(sql: Sql) {
  const [row] = await sql`SELECT v.approved_snapshot FROM job_search_brief_state s
    JOIN job_search_brief_versions v ON v.version=s.active_version WHERE s.singleton=true`;
  if (!row) return null;
  // Persisted snapshots are revalidated; draft or caller-supplied approval is never consumed.
  return compileSearchBrief(row.approved_snapshot);
}
export async function readBriefState(sql: Sql) {
  const [row] = await sql`SELECT v.draft,v.content_hash FROM job_search_brief_state s
    LEFT JOIN job_search_brief_versions v ON v.version=s.draft_version WHERE s.singleton=true`;
  const draft = row?.draft as SearchBriefDraft | null;
  return { draft: draft ?? null, review: draft ? reviewSearchBrief(draft) : null,
    active: await readActiveSearchBrief(sql),
    messages: await sql`SELECT id,text FROM job_search_brief_messages ORDER BY created_at,id` };
}
export async function saveBriefProposal(raw: { proposal: SearchBriefProposal; expectedDraftHash: string | null }, sql: Sql) {
  const input = briefProposeSchema.parse(raw);
  if (input.proposal.criteria.length > 30 || JSON.stringify(input.proposal).length > 24000) rejected('Keep a brief to 30 criteria and 24,000 characters.');
  if (payloadBytes(input.proposal.criteria.map(({ id, topic, kind, state, parameter }) => ({ id, topic, kind, state, parameter }))) > 4000)
    rejected('Keep interpreted criteria within the 4,000-byte workflow budget. Shorten parameter values.');
  const state = await readBriefState(sql);
  // A retry of the exact saved proposal is idempotent even after a lost response.
  if (state.draft && fingerprint(state.draft.proposal) === fingerprint(input.proposal)) return { ...state, reused: true };
  if ((state.review?.contentHash ?? null) !== input.expectedDraftHash) rejected('The draft changed. Read the current brief before proposing a revision.');
  const [last] = await sql`SELECT draft FROM job_search_brief_versions ORDER BY version DESC LIMIT 1`;
  const transcript = state.messages.map((m) => ({ id: String(m.id), role: 'user' as const, text: String(m.text) }));
  const draft = proposeSearchBrief('local-search-brief', input.proposal, transcript, last?.draft);
  const review = reviewSearchBrief(draft);
  await sql`INSERT INTO job_search_brief_versions(version,draft,content_hash) VALUES(${draft.version},${JSON.stringify(draft)}::jsonb,${review.contentHash})`;
  await sql`UPDATE job_search_brief_state SET draft_version=${draft.version} WHERE singleton=true`;
  return { ...(await readBriefState(sql)), reused: false };
}
export async function activateBrief(raw: z.infer<typeof briefApproveSchema>, sql: Sql) {
  const input = briefApproveSchema.parse(raw), state = await readBriefState(sql);
  if (state.active?.identity.contentHash === input.reviewedHash) return { active: state.active, reused: true };
  if ((state.active?.identity.contentHash ?? null) !== input.expectedActiveHash) rejected('The active brief changed. Review the current brief before approving.');
  if (!state.draft || state.review?.contentHash !== input.reviewedHash) rejected('The draft changed since review. Review it again.');
  const approved = approveSearchBrief(state.draft!, input.reviewedHash, new Date().toISOString());
  await sql`UPDATE job_search_brief_versions SET approved_snapshot=${JSON.stringify(approved)}::jsonb WHERE version=${approved.identity.version}`;
  await sql`UPDATE job_search_brief_state SET active_version=${approved.identity.version},draft_version=NULL WHERE singleton=true`;
  return { active: compileSearchBrief(approved), reused: false };
}
export async function cancelBriefDraft(raw: z.infer<typeof briefCancelSchema>, sql: Sql) {
  const input = briefCancelSchema.parse(raw), state = await readBriefState(sql);
  if (!state.draft) return { cancelled: false, reused: true };
  if (state.review?.contentHash !== input.expectedDraftHash) rejected('The draft changed. Read it before cancelling.');
  await sql`UPDATE job_search_brief_state SET draft_version=NULL WHERE singleton=true`;
  return { cancelled: true, reused: false };
}

/** Keep quote provenance retrievable through brief.read; packets need only the
 * approved interpretation. Preferences and unanswered tradeoffs remain distinct. */
export function compactSearchBrief(active: NonNullable<Awaited<ReturnType<typeof readActiveSearchBrief>>>) {
  const compact = (items: typeof active.preferences) => items.map(({ criterionId, parameter }) => ({ criterionId, parameter }));
  return { identity: active.identity, hardRequirements: compact(active.hardRequirements), preferences: compact(active.preferences),
    dealbreakers: compact(active.dealbreakers), unresolved: active.unresolved.map(({ id, topic, kind, state }) => ({ id, topic, kind, state })) };
}
