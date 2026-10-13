import { z } from 'zod';
import type { TruthClaim } from './resume-truth';

export const truthStatuses = ['unreviewed', 'reviewed', 'rejected'] as const;
export type TruthStatus = typeof truthStatuses[number];
export const projectTruthSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  claim: z.string().trim().min(1).max(4000),
  sourceNote: z.string().trim().min(1).max(1000),
}).strict();
export type ProjectTruthInput = z.infer<typeof projectTruthSchema>;
export const reviewBatchSchema = z.object({
  changes: z.array(z.object({
    id: z.string().min(1).max(200),
    expectedVersion: z.string().min(1).max(100),
    reviewStatus: z.enum(truthStatuses),
    claim: z.string().trim().min(1).max(4000).optional(),
    sourceNote: z.string().trim().min(1).max(1000).optional(),
  }).strict()).min(1).max(200),
}).strict().refine(({ changes }) => new Set(changes.map(({ id }) => id)).size === changes.length, 'Select each truth only once.');
export type TruthChange = z.infer<typeof reviewBatchSchema>['changes'][number];
export type ReviewClaim = TruthClaim & { version: string };
export type TruthSection = 'Personal details' | 'Work experience' | 'Skills' | 'Education' | 'Other claims';
export const truthSections: TruthSection[] = ['Personal details', 'Work experience', 'Skills', 'Education', 'Other claims'];
export type TruthGroup = { id: string; section: TruthSection; label: string; claims: ReviewClaim[] };

// An accomplishment headline usually restates one role bullet. Pair them only
// when the wording clearly overlaps one bullet more than any other, so edits or
// reordering never invent a relationship from positional IDs alone.
const STOP_WORDS = new Set('a an the and or of to in for with by on at as from into over across within its their our'.split(' '));
const words = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9$%.]+/g) ?? []).filter((word) => !STOP_WORDS.has(word)));
function overlap(a: Set<string>, b: Set<string>) {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
}
export const PAIR_MIN_OVERLAP = 0.3;
export const PAIR_MIN_LEAD = 0.2;
export function relatedTruthPairs(claims: ReviewClaim[]): Map<string, string> {
  const pairs = new Map<string, string>();
  const bullets = claims.filter((claim) => /^experience\.\d+\.claim\.\d+$/.test(claim.id)).map((claim) => ({ id: claim.id, words: words(claim.claim) }));
  const taken = new Set<string>();
  for (const summary of claims.filter((claim) => /^accomplishment\.\d+$/.test(claim.id))) {
    const target = words(summary.claim);
    const ranked = bullets.map((bullet) => ({ id: bullet.id, score: overlap(target, bullet.words) })).sort((a, b) => b.score - a.score);
    const [best, next] = ranked;
    if (best && best.score >= PAIR_MIN_OVERLAP && best.score - (next?.score ?? 0) >= PAIR_MIN_LEAD && !taken.has(best.id)) {
      pairs.set(best.id, summary.id);
      taken.add(best.id);
    }
  }
  return pairs;
}
export function groupTruths(claims: ReviewClaim[]): TruthGroup[] {
  const groups = new Map<string, TruthGroup>();
  const pairs = relatedTruthPairs(claims);
  const reversePairs = new Map([...pairs].map(([a, b]) => [b, a]));
  for (const claim of claims) {
    const sourceId = reversePairs.get(claim.id) ?? claim.id;
    const role = sourceId.match(/^experience\.(\d+)\./)?.[1];
    let id = 'other', section: TruthSection = 'Other claims', label = 'Other claims';
    if (role) {
      id = `experience.${role}`; section = 'Work experience';
      label = claims.find((item) => item.id === `${id}.employer`)?.claim ?? `Work experience ${role}`;
    } else if (sourceId.startsWith('earlier.')) {
      id = sourceId; section = 'Work experience'; label = claim.claim;
    } else if (sourceId.startsWith('profile.') || sourceId === 'summary') {
      id = 'personal'; section = 'Personal details'; label = 'Personal details';
    } else if (sourceId.startsWith('skills.')) {
      id = 'skills'; section = 'Skills'; label = 'Skills';
    } else if (sourceId.startsWith('education.')) {
      id = 'education'; section = 'Education'; label = 'Education';
    }
    if (!groups.has(id)) groups.set(id, { id, section, label, claims: [] });
    groups.get(id)!.claims.push(claim);
  }
  const rowOrder = (id: string) => id.endsWith('.title') ? 0 : id.endsWith('.dates') ? 1 : id.includes('.claim.') ? 2 : id.endsWith('.employer') ? 3 : 4;
  return [...groups.values()].sort((a, b) => truthSections.indexOf(a.section) - truthSections.indexOf(b.section) || Number(a.id.startsWith('earlier.')) - Number(b.id.startsWith('earlier.')) || a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map((group) => ({ ...group, claims: group.claims.sort((a, b) => rowOrder(a.id) - rowOrder(b.id) || a.id.localeCompare(b.id, undefined, { numeric: true })) }));
}
export function truthProgress(claims: TruthClaim[]) {
  return { reviewed: claims.filter((c) => c.reviewStatus === 'reviewed').length, unreviewed: claims.filter((c) => c.reviewStatus === 'unreviewed').length, rejected: claims.filter((c) => c.reviewStatus === 'rejected').length };
}
export function editedStatus(original: TruthClaim, draft: Pick<TruthClaim, 'claim' | 'sourceNote'>): TruthStatus {
  return original.reviewStatus === 'reviewed' && (draft.claim.trim() !== original.claim || draft.sourceNote.trim() !== original.sourceNote) ? 'unreviewed' : original.reviewStatus;
}


export function reviewedTruthsForDraft(claims: TruthClaim[]) {
  return claims.filter((claim) => claim.reviewStatus === 'reviewed').map(({ id, claim, sourceNote }) => ({ id, claim, sourceNote }));
}

const line = z.string().trim().min(1).max(4000);
/** A résumé the user's AI client extracted from their own document. */
export const resumeImportSchema = z.object({
  sourceNote: z.string().trim().min(8).max(1000),
  profile: z.object({
    name: line.optional(), headline: line.optional(), location: line.optional(), email: line.optional(),
    phone: line.optional(), website: line.optional(), linkedin: line.optional(), github: line.optional(),
  }).strict().default({}),
  summary: line.optional(),
  accomplishments: z.array(line).max(40).default([]),
  experience: z.array(z.object({
    employer: line, location: z.string().trim().max(200).optional(), title: line,
    dates: z.string().trim().max(100).optional(), bullets: z.array(line).max(40).default([]),
  }).strict()).max(40).default([]),
  earlier: z.array(line).max(40).default([]),
  skills: z.array(line).max(60).default([]),
  education: z.array(line).max(30).default([]),
  other: z.array(line).max(100).default([]),
}).strict();
export type ResumeImport = z.input<typeof resumeImportSchema>;

/** Assigns the ID shapes groupTruths understands. Every claim starts unreviewed. */
export function resumeImportClaims(raw: ResumeImport): TruthClaim[] {
  const input = resumeImportSchema.parse(raw);
  const claims: TruthClaim[] = [];
  const add = (id: string, claim: string | undefined) => {
    if (claim?.trim()) claims.push({ id, claim: claim.trim(), sourceNote: input.sourceNote, reviewStatus: 'unreviewed' });
  };
  for (const [key, value] of Object.entries(input.profile)) add(`profile.${key}`, value);
  add('summary', input.summary);
  input.accomplishments.forEach((text, index) => add(`accomplishment.${index + 1}`, text));
  input.experience.forEach((role, index) => {
    const id = `experience.${index + 1}`;
    add(`${id}.employer`, role.location ? `${role.employer} — ${role.location}` : role.employer);
    add(`${id}.title`, role.title);
    add(`${id}.dates`, role.dates);
    role.bullets.forEach((bullet, bulletIndex) => add(`${id}.claim.${bulletIndex + 1}`, bullet));
  });
  input.earlier.forEach((text, index) => add(`earlier.${index + 1}`, text));
  input.skills.forEach((text, index) => add(`skills.${index + 1}`, text));
  input.education.forEach((text, index) => add(`education.${index + 1}`, text));
  input.other.forEach((text, index) => add(`other.${index + 1}`, text));
  return claims;
}

/** Plain pasted text: one claim per non-trivial line, bullets and headings stripped. */
export function pastedResumeLines(text: string): string[] {
  if (text.length > 100_000) throw new Error('Paste up to 100,000 characters at a time.');
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const value = rawLine.replace(/^\s*(?:[-*•▪◦·]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim();
    const key = value.toLowerCase();
    if (value.length < 3 || value.length > 4000 || seen.has(key)) continue;
    seen.add(key);
    lines.push(value);
  }
  if (lines.length > 300) throw new Error('Paste at most 300 lines at a time.');
  return lines;
}
