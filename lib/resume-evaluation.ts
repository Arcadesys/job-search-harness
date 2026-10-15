import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MaterialManifest } from './job-workflow';
import type { ReviewClaim } from './resume-truth-review';

/** Hand-labelled fixture evidence, not a semantic inference or a keyword score. */
export type RequirementLabel = { id: string; text: string; acceptableClaimIds: string[]; transferable?: boolean };
export type ApprovedBriefIdentity = { briefId: string; version: number; contentHash: string };
export type ResumeEvaluationInput = {
  /** Identities come from the approval-validated search-brief compiler, not model output. */
  approvedSearchBrief?: { used: ApprovedBriefIdentity; current: ApprovedBriefIdentity };
  manifest: MaterialManifest;
  currentClaims: ReviewClaim[];
  posting: { text: string; hash: string; verified: boolean };
  artifact: { id: string; bytes: Uint8Array; expectedHash: string; extractedText: string; rendererText: string };
  oracle: { expectedText: string; requirements: RequirementLabel[]; forbiddenText: string[];
    expectedRecommendation: 'candidate' | 'uncertain' | 'exclude' };
  recommendation: 'candidate' | 'uncertain' | 'exclude';
};
export const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
// PDF wrapping changes whitespace; punctuation, numbers, wording and order still matter.
export const normalizeResumeText = (text: string) => text.replace(/\s+/gu, ' ').trim();
export type EvaluationIssue = { code: string; claimId?: string; requirementId?: string };
export function labelledCoverage(selectedIds: string[], requirements: RequirementLabel[]) {
  const selected = new Set(selectedIds);
  const rows = requirements.map((requirement) => ({ id: requirement.id,
    supported: requirement.acceptableClaimIds.length > 0,
    covered: requirement.acceptableClaimIds.some((id) => selected.has(id)),
    transferable: Boolean(requirement.transferable),
    missingEvidenceIds: requirement.acceptableClaimIds.filter((id) => !selected.has(id)),
  }));
  const supported = rows.filter((r) => r.supported), transferable = supported.filter((r) => r.transferable);
  const covered = supported.filter((r) => r.covered).length;
  return { rows, supportedRequirements: supported.length, coveredRequirements: covered,
    coverage: supported.length ? covered / supported.length : null,
    transferableRequirements: transferable.length, coveredTransferableRequirements: transferable.filter((r) => r.covered).length,
    unsupportedRequirements: rows.filter((r) => !r.supported).length };
}

/** Offline invariant checks. A pass is NOT an approval, factual verification of the
 * underlying source, visual inspection, semantic entailment or hiring prediction. */
export function evaluateResume(input: ResumeEvaluationInput) {
  const issues: EvaluationIssue[] = [];
  const add = (code: string, claimId?: string, requirementId?: string) => issues.push({ code, ...(claimId ? { claimId } : {}), ...(requirementId ? { requirementId } : {}) });
  const { manifest, currentClaims, artifact, oracle, posting } = input;
  if (input.approvedSearchBrief) {
    const { used, current } = input.approvedSearchBrief;
    if (!used.briefId || !Number.isInteger(used.version) || used.version < 1 || !/^[a-f0-9]{64}$/.test(used.contentHash)
      || used.briefId !== current.briefId || used.version !== current.version || used.contentHash !== current.contentHash) add('stale_search_brief');
  }
  const selectedIds = manifest.selection.sections.flatMap((s) => s.claimIds);
  if (new Set(selectedIds).size !== selectedIds.length) add('duplicate_selection');
  if (new Set(manifest.claims.map((c) => c.id)).size !== manifest.claims.length) add('duplicate_snapshot');
  const assembledText = manifest.sections.map((s) => `${s.heading}\n${s.lines.join('\n')}`).join('\n\n');
  if (normalizeResumeText(assembledText) !== normalizeResumeText(artifact.extractedText)) add('manifest_pdf_mismatch');
  if (!posting.text.trim() || !posting.verified) add('missing_or_unverified_posting');
  if (manifest.postingHash !== posting.hash) add('stale_posting');
  if (digest(artifact.bytes) !== artifact.expectedHash) add('artifact_hash_mismatch');
  const requiredIds = new Set(['profile.name', ...selectedIds]);
  for (const id of selectedIds) {
    const role = /^experience\.(\d+)\./.exec(id)?.[1];
    if (role) for (const key of ['employer', 'title', 'dates']) requiredIds.add(`experience.${role}.${key}`);
  }
  for (const id of requiredIds) if (!manifest.claims.some((c) => c.id === id)) add('selected_claim_missing_snapshot', id);
  const renderedClaimText = [manifest.sections[0]?.heading, ...manifest.sections.flatMap((s) => s.lines)];
  for (const text of renderedClaimText) {
    if (!manifest.claims.some((c) => c.claim === text)) add('rendered_claim_missing_snapshot');
  }
  for (const claim of manifest.claims) {
    const current = currentClaims.find((c) => c.id === claim.id);
    if (!current) { add('unknown_claim', claim.id); continue; }
    if (current.reviewStatus !== 'reviewed') add('unapproved_claim', claim.id);
    if (!claim.version || current.version !== claim.version) add('stale_claim', claim.id);
    if (current.claim !== claim.claim) add('claim_text_changed', claim.id);
    if (!claim.sourceNote.trim() || claim.sourceNote !== current.sourceNote) add('provenance_mismatch', claim.id);
    if (!normalizeResumeText(artifact.extractedText).includes(normalizeResumeText(claim.claim))) add('claim_missing_from_pdf', claim.id);
  }
  // Independent full-document golden catches extra prose, role misattribution,
  // repeated bullets and omissions, even when every selected claim is legitimate.
  if (normalizeResumeText(artifact.extractedText) !== normalizeResumeText(oracle.expectedText)) add('pdf_golden_mismatch');
  if (normalizeResumeText(artifact.rendererText) !== normalizeResumeText(artifact.extractedText)) add('renderer_pdf_mismatch');
  for (const forbidden of oracle.forbiddenText) {
    if (forbidden && normalizeResumeText(artifact.extractedText).includes(normalizeResumeText(forbidden))) add('forbidden_employer_content');
  }
  for (const claim of manifest.claims) {
    if (claim.sourceNote && normalizeResumeText(artifact.extractedText).includes(normalizeResumeText(claim.sourceNote))) add('private_provenance_leak', claim.id);
  }
  const coverage = labelledCoverage(selectedIds, oracle.requirements);
  for (const row of coverage.rows) if (row.supported && !row.covered) add('labelled_evidence_missed', undefined, row.id);
  const falseExclusion = input.recommendation === 'exclude' && oracle.expectedRecommendation !== 'exclude';
  if (falseExclusion) add('false_exclusion');
  if (input.recommendation !== oracle.expectedRecommendation) add('recommendation_golden_mismatch');
  return { schemaVersion: 1 as const, passed: issues.length === 0, issues, coverage, falseExclusion,
    binding: { artifactId: artifact.id, artifactHash: digest(artifact.bytes), postingHash: posting.hash, postingTextHash: digest(posting.text),
      ...(input.approvedSearchBrief ? { approvedSearchBrief: input.approvedSearchBrief.used } : {}),
      claimSnapshotHash: digest(JSON.stringify(manifest.claims)) },
    limits: ['Source truth is user-reviewed, not independently verified.', 'Coverage uses hand-labelled fixture evidence, not semantic entailment.',
      'No visual, recruiter or hiring-outcome judgment was performed.', 'A passing evaluation never approves an application.'] };
}

export const recruiterReviewSchema = z.object({
  schemaVersion: z.literal(1),
  binding: z.object({ artifactId: z.string().min(1), artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
    postingHash: z.string().min(1), postingTextHash: z.string().regex(/^[a-f0-9]{64}$/),
    approvedSearchBrief: z.object({ briefId: z.string().min(1), version: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
    claimSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  rubricVersion: z.literal('recruiter-advisory-1'),
  reviewer: z.string().min(1).max(200),
  findings: z.array(z.object({ category: z.enum(['unsupported_implication', 'missing_evidence', 'relevance', 'clarity']),
    concern: z.string().min(1).max(1000), claimIds: z.array(z.string()).max(30),
    resumeQuote: z.string().max(2000), postingQuote: z.string().max(2000),
  }).strict().refine((finding) => Boolean(finding.resumeQuote.trim() || finding.postingQuote.trim()), 'Cite résumé or posting evidence for each concern.')
    .refine((finding) => finding.category !== 'unsupported_implication' || Boolean(finding.resumeQuote.trim()), 'Unsupported implications require a résumé quote.')).max(20),
}).strict();
/** Optional adapter for a human or separately authorized judge. No provider call,
 * persistence, scoring or approval side effect. Caller saves the returned record. */
export function bindRecruiterReview(value: unknown, input: ResumeEvaluationInput) {
  const parsed = recruiterReviewSchema.parse(value);
  const evaluation = evaluateResume(input);
  if (!evaluation.passed) throw new Error('Deterministic checks must pass before attaching advisory review.');
  for (const key of ['artifactId', 'artifactHash', 'postingHash', 'postingTextHash', 'claimSnapshotHash'] as const)
    if (parsed.binding[key] !== evaluation.binding[key]) throw new Error('Advisory review binding is stale or belongs to another artifact.');
  const suppliedBrief = parsed.binding.approvedSearchBrief, expectedBrief = evaluation.binding.approvedSearchBrief;
  if (suppliedBrief?.briefId !== expectedBrief?.briefId || suppliedBrief?.version !== expectedBrief?.version
    || suppliedBrief?.contentHash !== expectedBrief?.contentHash) throw new Error('Advisory search brief binding is stale.');
  for (const finding of parsed.findings) {
    if (finding.claimIds.some((id) => !input.manifest.claims.some((claim) => claim.id === id))) throw new Error('Advisory review cites an unknown selected claim.');
    if (finding.resumeQuote && !normalizeResumeText(input.artifact.extractedText).includes(normalizeResumeText(finding.resumeQuote))) throw new Error('Advisory résumé quote is not present in the artifact.');
    if (finding.postingQuote && !input.posting.text.includes(finding.postingQuote)) throw new Error('Advisory posting quote is not present.');
  }
  return { ...parsed, advisoryOnly: true as const, approvalGranted: false as const };
}
