import type { ReviewClaim } from './resume-truth-review';

type Lead = { title: string; source: string; sourceUrl: string; verificationStatus: string };

const roleSignals = [
  { title: /forward[- ]deployed|solutions? engineer/i, lane: 'customer-facing AI and technical delivery', claims: ['experience.1.claim.5', 'experience.1.claim.7', 'accomplishment.4'] },
  { title: /scrum|agile/i, lane: 'agile coaching and delivery', claims: ['experience.3.claim.1', 'experience.4.claim.1', 'accomplishment.7'] },
  { title: /\bAI\b.*engineer|engineer.*\bAI\b/i, lane: 'hands-on AI building and evaluation', claims: ['experience.1.claim.7', 'experience.1.claim.5', 'accomplishment.4'] },
  { title: /product/i, lane: 'product ownership and AI-enabled product work', claims: ['experience.5.claim.2', 'experience.1.claim.4', 'experience.2.claim.3'] },
  { title: /program|adoption|enablement|transformation/i, lane: 'AI enablement and cross-functional program delivery', claims: ['experience.1.claim.1', 'experience.1.claim.6', 'experience.2.claim.1'] },
  { title: /engineer|developer|automation|genai|\bAI\b/i, lane: 'hands-on AI building and evaluation', claims: ['experience.1.claim.7', 'experience.1.claim.5', 'accomplishment.4'] },
] as const;

export function leadFitPreview(lead: Lead, claims: Pick<ReviewClaim, 'id' | 'claim' | 'reviewStatus'>[]) {
  if (!lead.source.startsWith('linkedin-email')) return null;
  const signal = roleSignals.find((item) => item.title.test(lead.title));
  const evidence = signal?.claims.map((id) => claims.find((claim) => claim.id === id && claim.reviewStatus === 'reviewed')).find(Boolean);
  return {
    reason: signal && evidence
      ? `The alert title suggests ${signal.lane}. A reviewed résumé fact supports that connection: “${evidence.claim}”`
      : 'The email alert does not yet provide enough reviewed evidence for a specific fit reason.',
    claimId: evidence?.id,
    caution: lead.verificationStatus === 'verified'
      ? 'Check the saved original posting for requirements and current availability before deciding to pursue.'
      : 'Preliminary title-based match only. The email did not include verified requirements; open the posting to check scope, location, and availability.',
  };
}
