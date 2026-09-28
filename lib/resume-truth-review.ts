import { z } from 'zod';
import type { TruthClaim } from './resume-truth';

export const truthStatuses = ['unreviewed', 'reviewed', 'rejected'] as const;
export type TruthStatus = typeof truthStatuses[number];
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

// Source IDs identify the original import, but positional IDs alone are not evidence
// of a relationship after edits/reordering. Require the known wording on both sides.
const relatedRules = [
  { accomplishment: 'accomplishment.1', role: 'experience.1.', wording: /agentic-coding adoption/i },
  { accomplishment: 'accomplishment.2', role: 'experience.1.', wording: /Devin adoption/i },
  { accomplishment: 'accomplishment.3', role: 'experience.1.', wording: /March 2026 roadshow/i },
  { accomplishment: 'accomplishment.4', role: 'experience.1.', wording: /Built Wavelength/i },
  { accomplishment: 'accomplishment.5', role: 'experience.1.', wording: /Within four days of arrival/i },
  { accomplishment: 'accomplishment.6', role: 'experience.3.', wording: /planning time by 50%/i },
  { accomplishment: 'accomplishment.7', role: 'experience.4.', wording: /throughput by 400%/i },
  { accomplishment: 'accomplishment.8', role: 'experience.5.', wording: /\$1\.5B in locked loan volume/i },
];
export function relatedTruthPairs(claims: ReviewClaim[]): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const rule of relatedRules) {
    const summary = claims.find((claim) => claim.id === rule.accomplishment && rule.wording.test(claim.claim));
    const matches = claims.filter((claim) => claim.id.startsWith(`${rule.role}claim.`) && rule.wording.test(claim.claim));
    if (summary && matches.length === 1) pairs.set(matches[0].id, summary.id);
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
