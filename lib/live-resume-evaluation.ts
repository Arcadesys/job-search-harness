import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MaterialManifest } from './job-workflow';
import type { ReviewClaim } from './resume-truth-review';
import { fingerprint } from './workflow-hash';

export const evaluatorVersion = 'resume-live-1' as const;
export const rubricVersion = 'recruiter-live-1' as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.object({ briefId: z.string().min(1).max(200), version: z.number().int().positive(), contentHash: hash }).strict();
export const liveResumeBindingSchema = z.object({
  artifactId: z.string().min(1).max(200), artifactHash: hash,
  materialId: z.string().min(1).max(200), inputHash: hash,
  postingHash: hash, postingTextHash: hash, claimSnapshotHash: hash, catalogHash: hash,
  approvedSearchBrief: identity.nullable(), evaluatorVersion: z.literal(evaluatorVersion), rubricVersion: z.literal(rubricVersion),
}).strict();
export type LiveResumeBinding = z.infer<typeof liveResumeBindingSchema>;
export type LiveResumeEvaluationInput = {
  manifest: MaterialManifest; currentClaims: ReviewClaim[];
  posting: { text: string; hash: string; verified: boolean };
  artifact: { id: string; bytes: Uint8Array; expectedHash: string; extractedText: string };
  binding: LiveResumeBinding;
  /** Trusted current settings; URLs and labels are bound by the material input hash. */
  links?: { label: string; url: string }[];
  /** Recompiled from current approved inputs by the runtime, never supplied by a reviewer. */
  expectedManifest?: MaterialManifest;
};
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
const documentText = (manifest: Pick<MaterialManifest, 'sections'>, links: { label: string; url: string }[] = []) => manifest.sections
  .map((section, index) => [section.heading, ...section.lines, ...(!index ? links.map((link) => link.label) : [])].join('\n')).join('\n\n');
export type LiveResumeIssue = { code: string; claimId?: string };

/** Pure mechanical checks, with no fixture oracle, provider calls or approval side effects. */
export function evaluateLiveResume(input: LiveResumeEvaluationInput) {
  const { manifest, currentClaims, posting, artifact, binding } = input;
  const issues: LiveResumeIssue[] = [];
  const add = (code: string, claimId?: string) => { issues.push({ code, ...(claimId ? { claimId } : {}) }); };
  if (!liveResumeBindingSchema.safeParse(binding).success) add('invalid_binding');
  if (binding.artifactId !== artifact.id || binding.artifactHash !== artifact.expectedHash) add('artifact_binding_mismatch');
  if (digest(artifact.bytes) !== artifact.expectedHash) add('artifact_hash_mismatch');
  if (!posting.verified || !posting.text.trim()) add('missing_or_unverified_posting');
  if (manifest.postingHash !== posting.hash || binding.postingHash !== posting.hash || binding.postingTextHash !== digest(posting.text)) add('stale_posting');
  if (binding.claimSnapshotHash !== fingerprint(manifest.claims)) add('stale_claim_snapshot');
  if (binding.catalogHash !== fingerprint(currentClaims.filter((c) => c.reviewStatus === 'reviewed').map(({ id, claim, version }) => ({ id, claim, version })))) add('stale_catalog');
  if (fingerprint(binding.approvedSearchBrief) !== fingerprint(manifest.approvedSearchBrief ?? null)) add('stale_search_brief');
  const ids = manifest.selection.sections.flatMap((s) => s.claimIds);
  if (new Set(ids).size !== ids.length) add('duplicate_selection');
  if (new Set(manifest.claims.map((c) => c.id)).size !== manifest.claims.length) add('duplicate_snapshot');
  if (new Set(currentClaims.map((c) => c.id)).size !== currentClaims.length) add('duplicate_current_claim');
  if (manifest.selection.unresolved.length) add('unresolved_selection');
  if (manifest.selection.template !== 'approved-resume-1') add('unknown_template');
  const byId = new Map(currentClaims.filter((c) => c.reviewStatus === 'reviewed').map((c) => [c.id, c]));
  const used = new Set<string>();
  const take = (id: string) => {
    if (used.has(id)) add('duplicate_rendered_claim', id);
    used.add(id);
    const claim = byId.get(id);
    if (!claim) add('required_approved_claim_missing', id);
    return claim?.claim ?? '';
  };
  const name = take('profile.name');
  const contacts = ['email', 'phone', 'website', 'linkedin', 'github', 'location'].map((key) => `profile.${key}`).filter((id) => byId.has(id));
  if (!contacts.some((id) => /\.(email|phone|website)$/.test(id))) add('missing_contact');
  const sections = [{ heading: name, lines: [...(byId.has('profile.headline') ? [take('profile.headline')] : []), ...contacts.map(take)] }];
  const labels: Record<string, string> = { summary: 'Summary', experience: 'Experience', accomplishments: 'Selected accomplishments', skills: 'Skills', education: 'Education', other: 'Additional experience' };
  for (const section of manifest.selection.sections) {
    if (section.kind === 'profile') continue;
    const lines: string[] = [], roles = new Set<string>();
    let previousRole: string | undefined;
    for (const id of section.claimIds) {
      const role = /^experience\.(\d+)\./.exec(id)?.[1];
      if (section.kind === 'experience' && !role) add('ungrouped_experience_claim', id);
      if (role && roles.has(role) && previousRole !== role) add('misattributed_role', id);
      if (role && !roles.has(role)) {
        roles.add(role);
        lines.push(take(`experience.${role}.employer`), take(`experience.${role}.title`), take(`experience.${role}.dates`));
      }
      previousRole = role;
      if (role && /\.(employer|title|dates)$/.test(id)) continue;
      lines.push(take(id));
    }
    sections.push({ heading: labels[section.kind], lines });
  }
  if (![...used].some((id) => !id.startsWith('profile.'))) add('missing_substantive_claim');
  for (const id of ids) if (!used.has(id)) add('selected_claim_not_rendered', id);
  for (const id of used) if (!manifest.claims.some((c) => c.id === id)) add('selected_claim_missing_snapshot', id);
  for (const claim of manifest.claims) {
    if (!used.has(claim.id)) add('unselected_snapshot_claim', claim.id);
    const current = currentClaims.find((c) => c.id === claim.id);
    if (!current) { add('unknown_claim', claim.id); continue; }
    if (current.reviewStatus !== 'reviewed') add('unapproved_claim', claim.id);
    if (!claim.version || claim.version !== current.version) add('stale_claim', claim.id);
    if (!claim.claim.trim() || claim.claim !== current.claim) add('claim_text_changed', claim.id);
    if (!claim.sourceNote.trim() || claim.sourceNote !== current.sourceNote) add('provenance_mismatch', claim.id);
    if (!normalize(artifact.extractedText).includes(normalize(claim.claim))) add('claim_missing_from_pdf', claim.id);
  }
  if (fingerprint(sections) !== fingerprint(manifest.sections)) add('canonical_sections_mismatch');
  if (input.expectedManifest && fingerprint(input.expectedManifest) !== fingerprint(manifest)) add('current_manifest_mismatch');
  if (normalize(documentText(manifest, input.links)) !== normalize(artifact.extractedText)) add('manifest_pdf_mismatch');
  if (normalize(documentText({ sections }, input.links)) !== normalize(artifact.extractedText)) add('canonical_pdf_mismatch');
  // Notes are private provenance, never employer-facing output. Check the full current bank.
  for (const claim of currentClaims) if (claim.sourceNote.trim() && normalize(artifact.extractedText).includes(normalize(claim.sourceNote))) add('private_provenance_leak', claim.id);
  return { schemaVersion: 1 as const, evaluatorVersion, passed: issues.length === 0, issues, binding,
    approvalGranted: false as const,
    limits: ['Checks compare extracted PDF text, allowing whitespace changes from wrapping; visual layout is not inspected.',
      'Approved source claims are user-reviewed, not independently verified.',
      'Semantic entailment, job relevance and hiring outcomes are unknown; no fit score is calculated.',
      'Material identity and active approved brief currency must be established by the calling runtime.',
      'A passing result never approves or submits an application.'] };
}

export const liveRecruiterFindingSchema = z.object({
  category: z.enum(['unsupported_implication', 'missing_evidence', 'relevance', 'clarity']),
  concern: z.string().trim().min(1).max(1000),
  claimIds: z.array(z.string().min(1).max(200)).max(30),
  resumeQuote: z.string().max(2000), postingQuote: z.string().max(2000),
}).strict().refine((finding) => Boolean(finding.resumeQuote.trim() || finding.postingQuote.trim()), 'Cite résumé or posting evidence.')
  .refine((finding) => finding.category !== 'unsupported_implication' || Boolean(finding.resumeQuote.trim()), 'Unsupported implications require a résumé quote.')
  .refine((finding) => finding.category !== 'missing_evidence' || Boolean(finding.postingQuote.trim()), 'Missing evidence requires a posting quote.')
  .refine((finding) => new Set(finding.claimIds).size === finding.claimIds.length, 'Claim citations must be unique.');
export const liveRecruiterReviewSchema = z.object({
  schemaVersion: z.literal(1), binding: liveResumeBindingSchema, rubricVersion: z.literal(rubricVersion),
  reviewer: z.string().trim().min(1).max(200), findings: z.array(liveRecruiterFindingSchema).max(20),
}).strict();
export type LiveRecruiterReview = z.infer<typeof liveRecruiterReviewSchema>;
/** Treat all reviewer strings as untrusted display data. Exact citations establish
 * source presence only, not semantic support for the reviewer's interpretation. */
export function validateLiveRecruiterReview(value: unknown, input: LiveResumeEvaluationInput) {
  const parsed = liveRecruiterReviewSchema.parse(value);
  if (!evaluateLiveResume(input).passed) throw new Error('Current deterministic checks must pass before advisory review.');
  if (fingerprint(parsed.binding) !== fingerprint(input.binding)) throw new Error('Advisory binding is stale or belongs to another artifact.');
  for (const finding of parsed.findings) {
    if (finding.claimIds.some((id) => !input.manifest.claims.some((claim) => claim.id === id))) throw new Error('Advisory review cites an unknown selected claim.');
    if (finding.resumeQuote && (!finding.resumeQuote.trim() || !input.artifact.extractedText.includes(finding.resumeQuote))) throw new Error('Advisory résumé quote is not present exactly.');
    if (finding.postingQuote && (!finding.postingQuote.trim() || !input.posting.text.includes(finding.postingQuote))) throw new Error('Advisory posting quote is not present exactly.');
    if (finding.resumeQuote && finding.claimIds.length && !finding.claimIds.every((id) => {
      const text = input.manifest.claims.find((claim) => claim.id === id)!.claim;
      return normalize(text).includes(normalize(finding.resumeQuote)) || normalize(finding.resumeQuote).includes(normalize(text));
    })) throw new Error('Advisory résumé quote does not reference its cited claims.');
  }
  return { ...parsed, advisoryOnly: true as const, approvalGranted: false as const,
    limits: ['Quotes and selected claim identifiers are validated, not semantic judgments.', 'Reviewer objections and gaps require human review; no hiring prediction or approval is granted.'] };
}
