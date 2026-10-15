import { z } from 'zod';
import { canonical, fingerprint } from './workflow-hash';

const text = z.string().trim().min(1);
const amount = z.number().finite().nonnegative();
const range = z.object({ min: amount.nullable(), max: amount.nullable() }).strict()
  .refine((v) => v.min !== null || v.max !== null, 'Supply at least one bound.')
  .refine((v) => v.min === null || v.max === null || v.min <= v.max, 'Bounds are reversed.');

/** Structured data only. Free text never becomes executable provider instructions. */
export const searchParameterSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('salary'), range, currency: z.string().regex(/^[A-Z]{3}$/),
    period: z.enum(['hour', 'day', 'week', 'month', 'year']), basis: z.enum(['base', 'total_compensation']) }).strict(),
  z.object({ field: z.literal('work_mode'), modes: z.array(z.enum(['remote', 'hybrid', 'onsite'])).min(1) }).strict(),
  z.object({ field: z.literal('location'), places: z.array(text).min(1),
    scope: z.enum(['workplace', 'remote_eligibility', 'relocation']),
    radius: z.object({ value: amount, unit: z.enum(['km', 'mi']) }).strict().nullable() }).strict(),
  z.object({ field: z.literal('travel'), maximum: amount,
    unit: z.enum(['percent_of_work_time', 'days_per_month', 'nights_per_month']) }).strict()
    .refine((v) => v.unit !== 'percent_of_work_time' || v.maximum <= 100, 'Percentage cannot exceed 100.'),
  z.object({ field: z.enum(['role', 'industry', 'growth', 'work_style', 'values', 'schedule']), value: text }).strict(),
]);
export type SearchParameter = z.infer<typeof searchParameterSchema>;
const provenance = z.object({ messageId: text, quote: text }).strict();
const criterionSchema = z.object({
  id: text,
  topic: z.enum(['salary', 'work_mode', 'location', 'travel', 'role', 'industry', 'growth', 'work_style', 'values', 'schedule']),
  kind: z.enum(['hard_requirement', 'preference', 'dealbreaker', 'unknown_tradeoff']),
  state: z.enum(['answered', 'unanswered', 'declined']),
  parameter: searchParameterSchema.nullable(),
  sources: z.array(provenance).min(1),
}).strict().superRefine((v, ctx) => {
  if ((v.state === 'answered') !== (v.parameter !== null) || (v.parameter && v.parameter.field !== v.topic)) {
    ctx.addIssue({ code: 'custom', message: 'Only answered criteria have a parameter, matching their topic.' });
  }
  if (v.kind === 'unknown_tradeoff' && v.parameter !== null) ctx.addIssue({ code: 'custom', message: 'Resolve the tradeoff before assigning a parameter.' });
});

/** The only schema an AI adapter may return. It has no approval or revision fields. */
export const searchBriefProposalSchema = z.object({ criteria: z.array(criterionSchema) }).strict()
  .refine((v) => new Set(v.criteria.map((c) => c.id)).size === v.criteria.length, 'Criterion IDs must be unique.');
export type SearchBriefProposal = z.infer<typeof searchBriefProposalSchema>;
export type BriefTranscript = readonly { id: string; role: 'user' | 'assistant' | 'external'; text: string }[];
const draftSchema = z.object({ schemaVersion: z.literal(1), briefId: text, version: z.number().int().positive(),
  proposal: searchBriefProposalSchema }).strict();
export type SearchBriefDraft = z.infer<typeof draftSchema>;
export type ApprovedBriefIdentity = { briefId: string; version: number; contentHash: string };
const identitySchema = z.object({ briefId: text, version: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const approvedSchema = z.object({ draft: draftSchema, identity: identitySchema,
  approval: z.object({ actor: z.literal('user'), reviewedHash: z.string(), approvedAt: z.iso.datetime() }).strict() }).strict();
export type ApprovedSearchBrief = z.infer<typeof approvedSchema>;

export function proposeSearchBrief(briefId: string, raw: unknown, transcript: BriefTranscript,
  previous?: SearchBriefDraft): SearchBriefDraft {
  const proposal = searchBriefProposalSchema.parse(raw);
  for (const c of proposal.criteria) for (const source of c.sources) {
    if (!transcript.some((m) => m.id === source.messageId && m.role === 'user' && m.text.includes(source.quote))) {
      throw new Error('Every criterion needs an exact quote from a user message.');
    }
  }
  if (previous) {
    draftSchema.parse(previous);
    if (previous.briefId !== briefId) throw new Error('A revision must retain its brief ID.');
  }
  return draftSchema.parse({ schemaVersion: 1, briefId, version: previous ? previous.version + 1 : 1, proposal });
}

export type Clarification = { criterionIds: string[]; reason: 'missing_answer' | 'unknown_tradeoff' | 'contradiction'; question: string; canDecline: true };
const questions: Record<SearchParameter['field'], string> = {
  salary: 'What amount, currency, pay period, and base pay or total compensation do you mean? Is it a minimum or a preference?',
  work_mode: 'Which of remote, hybrid, or onsite would work for you, and which are essential versus preferred?',
  location: 'Which workplace or remote-eligibility locations do you mean? If using a radius, what distance and unit?',
  travel: 'What travel level would work for you, measured as percent of work time, days per month, or nights per month?',
  role: 'What work or roles would you like, and is that essential or preferred?',
  industry: 'Which industries would you prefer or rule out?',
  growth: 'What kind of growth matters to you, and how would you weigh it against your other preferences?',
  work_style: 'What working style matters to you, and is it essential or preferred?',
  values: 'Which workplace values matter to your search, and is each essential or preferred?',
  schedule: 'What schedule would work for you, and is it essential or preferred?',
};

export function clarifySearchBrief(raw: SearchBriefDraft): Clarification[] {
  const { proposal } = draftSchema.parse(raw);
  const result: Clarification[] = proposal.criteria.filter((c) => c.state === 'unanswered').map((c) => ({
    criterionIds: [c.id], reason: c.kind === 'unknown_tradeoff' ? 'unknown_tradeoff' : 'missing_answer',
    question: questions[c.topic], canDecline: true,
  }));
  const active = proposal.criteria.filter((c) => c.state === 'answered' && c.kind !== 'preference');
  for (let i = 0; i < active.length; i++) for (const b of active.slice(i + 1)) {
    const a = active[i];
    if (a.topic !== b.topic) continue;
    const opposite = a.kind !== b.kind && canonical(a.parameter) === canonical(b.parameter);
    if (opposite) result.push({ criterionIds: [a.id, b.id], reason: 'contradiction',
      question: `These ${a.topic} requirements conflict. Which should change, become a preference, or be left open?`, canDecline: true });
  }
  const modes = active.filter((c) => c.parameter?.field === 'work_mode');
  if (modes.length) {
    const allowed = ['remote', 'hybrid', 'onsite'].filter((mode) => modes.every((c) => {
      const includes = c.parameter?.field === 'work_mode' && c.parameter.modes.some((m) => m === mode);
      return c.kind === 'dealbreaker' ? !includes : includes;
    }));
    if (!allowed.length) result.push({ criterionIds: modes.map((c) => c.id), reason: 'contradiction',
      question: 'No work mode meets these requirements and exclusions. Which should change or be left open?', canDecline: true });
  }
  const salaries = active.filter((c) => c.kind === 'hard_requirement' && c.parameter?.field === 'salary');
  for (let i = 0; i < salaries.length; i++) for (const b of salaries.slice(i + 1)) {
    const a = salaries[i];
    const x = a.parameter, y = b.parameter;
    if (x?.field === 'salary' && y?.field === 'salary' && x.currency === y.currency && x.period === y.period && x.basis === y.basis &&
      Math.max(x.range.min ?? 0, y.range.min ?? 0) > Math.min(x.range.max ?? Infinity, y.range.max ?? Infinity)) {
      result.push({ criterionIds: [a.id, b.id], reason: 'contradiction',
        question: 'These salary bounds do not overlap. Which should change or be left open?', canDecline: true });
    }
  }
  const salaryGroups = new Map<string, typeof active>();
  for (const c of active) if (c.parameter?.field === 'salary') {
    const p = c.parameter;
    const key = `${p.currency}/${p.period}/${p.basis}`;
    salaryGroups.set(key, [...(salaryGroups.get(key) ?? []), c]);
  }
  for (const group of salaryGroups.values()) {
    let lower = 0, upper = Infinity;
    const excluded: { min: number; max: number }[] = [];
    for (const c of group) if (c.parameter?.field === 'salary') {
      const bounds = { min: c.parameter.range.min ?? 0, max: c.parameter.range.max ?? Infinity };
      if (c.kind === 'dealbreaker') excluded.push(bounds);
      else { lower = Math.max(lower, bounds.min); upper = Math.min(upper, bounds.max); }
    }
    // Closed intervals can jointly cover the entire allowed salary range.
    let coveredThrough: number | null = null;
    for (const interval of excluded.sort((a, b) => a.min - b.min)) {
      if (interval.max < lower) continue;
      if (interval.min > (coveredThrough ?? lower)) break;
      coveredThrough = Math.max(coveredThrough ?? lower, interval.max);
    }
    if (lower <= upper && coveredThrough !== null && coveredThrough >= upper) result.push({
      criterionIds: group.map((c) => c.id), reason: 'contradiction',
      question: 'The salary exclusions rule out the entire required range. Which should change or be left open?', canDecline: true,
    });
  }
  return result;
}

export function reviewSearchBrief(raw: SearchBriefDraft) {
  const draft = draftSchema.parse(raw);
  const summary = draft.proposal.criteria.map((c) => ({ id: c.id, kind: c.kind, state: c.state,
    description: c.parameter ? describeParameter(c.parameter) : `${c.topic}: ${c.state}; no search constraint`, sources: c.sources }));
  return { contentHash: fingerprint(draft), summary, questions: clarifySearchBrief(draft) };
}

function describeParameter(p: SearchParameter): string {
  switch (p.field) {
    case 'salary': return `${p.basis}: ${p.range.min ?? 'no minimum'}–${p.range.max ?? 'no maximum'} ${p.currency}/${p.period}`;
    case 'work_mode': return `Work mode: ${p.modes.join(' or ')}`;
    case 'location': return `${p.scope}: ${p.places.join(' or ')}${p.radius ? ` within ${p.radius.value} ${p.radius.unit}` : ''}`;
    case 'travel': return `Travel: at most ${p.maximum} ${p.unit.replaceAll('_', ' ')}`;
    default: return `${p.field}: ${p.value}`;
  }
}

/** Trusted user-action boundary only; never call from model/tool output. Persist atomically. */
export function approveSearchBrief(raw: SearchBriefDraft, reviewedHash: string, approvedAt: string): ApprovedSearchBrief {
  const draft = draftSchema.parse(raw);
  const review = reviewSearchBrief(draft);
  if (review.contentHash !== reviewedHash) throw new Error('The brief changed since review. Review it again.');
  if (review.questions.some((q) => q.reason === 'contradiction')) throw new Error('Resolve conflicting requirements before approval.');
  return approvedSchema.parse({ draft, identity: { briefId: draft.briefId, version: draft.version, contentHash: reviewedHash },
    approval: { actor: 'user', reviewedHash, approvedAt } });
}

/** Revalidate persisted approval; drafts and mutated snapshots cannot drive a search. */
export function compileSearchBrief(raw: unknown) {
  const approved = approvedSchema.parse(raw);
  const { draft, identity, approval } = approved;
  if (identity.briefId !== draft.briefId || identity.version !== draft.version ||
    identity.contentHash !== fingerprint(draft) || approval.reviewedHash !== identity.contentHash ||
    clarifySearchBrief(draft).some((q) => q.reason === 'contradiction')) throw new Error('Invalid approved brief binding.');
  const criteria = draft.proposal.criteria;
  const select = (kind: 'hard_requirement' | 'preference' | 'dealbreaker') => criteria
    .filter((c) => c.kind === kind && c.state === 'answered').map((c) => ({ criterionId: c.id, parameter: c.parameter!, sources: c.sources }));
  return { identity, hardRequirements: select('hard_requirement'), preferences: select('preference'),
    dealbreakers: select('dealbreaker'), unresolved: criteria.filter((c) => c.state !== 'answered'),
    summary: reviewSearchBrief(draft).summary };
}

/** Conservative invalidation: re-evaluate brief-dependent decisions, never résumé truths. */
export function searchDecisionNeedsReassessment(cached: ApprovedBriefIdentity, current: ApprovedBriefIdentity): boolean {
  return canonical(identitySchema.parse(cached)) !== canonical(identitySchema.parse(current));
}
