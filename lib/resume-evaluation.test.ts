import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractPdfText } from '../scripts/evals/resume-output';
import { renderResumeEvalFixtures } from '../tests/fixtures/rendered-resume-evals';
import { evaluateResume, bindRecruiterReview, digest, labelledCoverage, type ResumeEvaluationInput } from './resume-evaluation';

// Store-free real rendering/parsing isolates detector tests from owner lifecycle.
const fixtures = renderResumeEvalFixtures();

test('all unmodified rendered fixtures pass the independent output oracle', async () => {
  for (const { id, report } of await fixtures) {
    assert.equal(report.passed, true, `${id}: ${JSON.stringify(report.issues)}`);
    assert.equal(report.coverage.coverage, 1);
  }
});


const mutations: { name: string; expected: string; change: (input: ResumeEvaluationInput) => void }[] = [
  { name: 'revoked selected claim', expected: 'unapproved_claim', change: (x) => { x.currentClaims.find((c) => c.id === x.manifest.claims[0].id)!.reviewStatus = 'rejected'; } },
  { name: 'unreviewed selected claim', expected: 'unapproved_claim', change: (x) => { x.currentClaims.find((c) => c.id === x.manifest.claims[0].id)!.reviewStatus = 'unreviewed'; } },
  { name: 'stale version', expected: 'stale_claim', change: (x) => { x.manifest.claims[0].version = 'old'; } },
  { name: 'missing version', expected: 'stale_claim', change: (x) => { delete x.manifest.claims[0].version; } },
  { name: 'invented wording', expected: 'claim_text_changed', change: (x) => { x.manifest.claims[0].claim = 'PMP certified'; } },
  { name: 'provenance substitution', expected: 'provenance_mismatch', change: (x) => { x.manifest.claims[0].sourceNote = 'An invented source'; } },
  { name: 'unknown claim', expected: 'unknown_claim', change: (x) => { x.manifest.claims[0].id = 'invented.id'; } },
  { name: 'duplicate claim selection', expected: 'duplicate_selection', change: (x) => { x.manifest.selection.sections[0].claimIds.push(x.manifest.selection.sections[0].claimIds[0]); } },
  { name: 'duplicate snapshot', expected: 'duplicate_snapshot', change: (x) => { x.manifest.claims.push(x.manifest.claims[0]); } },
  { name: 'missing snapshot', expected: 'selected_claim_missing_snapshot', change: (x) => { x.manifest.claims = x.manifest.claims.filter((c) => c.id !== x.manifest.selection.sections[0].claimIds[0]); } },
  { name: 'omitted PDF content', expected: 'claim_missing_from_pdf', change: (x) => { x.artifact.extractedText = 'Jordan Rivera'; } },
  { name: 'unapproved extra prose', expected: 'pdf_golden_mismatch', change: (x) => { x.artifact.extractedText += '\nManaged a $100M budget'; } },
  { name: 'wrong role attribution', expected: 'pdf_golden_mismatch', change: (x) => { x.artifact.extractedText = x.artifact.extractedText.replace('Maple Analytics', 'Wrong Employer'); } },
  { name: 'private review leak', expected: 'forbidden_employer_content', change: (x) => { x.artifact.extractedText += '\nPRIVATE_REVIEW_ONLY'; } },
  { name: 'source note leak', expected: 'private_provenance_leak', change: (x) => { x.artifact.extractedText += `\n${x.manifest.claims[0].sourceNote}`; } },
  { name: 'renderer trace lies', expected: 'renderer_pdf_mismatch', change: (x) => { x.artifact.rendererText += ' hidden'; } },
  { name: 'manifest lies', expected: 'manifest_pdf_mismatch', change: (x) => { x.manifest.sections[1].lines.push('PMP certified'); } },
  { name: 'corrupted PDF bytes', expected: 'artifact_hash_mismatch', change: (x) => { x.artifact.bytes = new Uint8Array([1, 2, 3]); } },
  { name: 'missing posting', expected: 'missing_or_unverified_posting', change: (x) => { x.posting.text = ''; } },
  { name: 'unverified posting', expected: 'missing_or_unverified_posting', change: (x) => { x.posting.verified = false; } },
  { name: 'changed posting version', expected: 'stale_posting', change: (x) => { x.posting.hash += '-new'; } },
  { name: 'false exclusion of a supported candidate', expected: 'false_exclusion', change: (x) => { x.recommendation = 'exclude'; } },
  { name: 'missed labelled evidence', expected: 'labelled_evidence_missed', change: (x) => { x.manifest.selection.sections[0].claimIds.shift(); } },
];
for (const mutation of mutations) test(`detector rejects ${mutation.name}`, async () => {
  const input = structuredClone((await fixtures)[0].input);
  mutation.change(input);
  const result = evaluateResume(input);
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.code === mutation.expected), JSON.stringify(result.issues));
});

test('actual mutated PDF bytes are independently extracted and rejected even with a fresh checksum', async () => {
  const input = structuredClone((await fixtures)[2].input);
  const pdf = await PDFDocument.create(), page = pdf.addPage(), font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('PMP certified INJECTION_ACCEPTED PRIVATE_REVIEW_ONLY', { x: 20, y: 700, size: 12, font });
  input.artifact.bytes = await pdf.save();
  input.artifact.expectedHash = digest(input.artifact.bytes);
  input.artifact.extractedText = await extractPdfText(input.artifact.bytes);
  const result = evaluateResume(input);
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((i) => i.code === 'forbidden_employer_content'));
  assert.ok(result.issues.some((i) => i.code === 'pdf_golden_mismatch'));
  await assert.rejects(extractPdfText(new Uint8Array([1, 2, 3])));
});

test('coverage is labelled evidence recall, including transferable evidence and explicit unsupported gaps', async () => {
  const input = (await fixtures)[1].input;
  const complete = labelledCoverage(input.manifest.selection.sections.flatMap((s) => s.claimIds), input.oracle.requirements);
  const missed = labelledCoverage(['experience.1.claim.6'], input.oracle.requirements);
  assert.equal(complete.coveredTransferableRequirements, 4);
  assert.equal(missed.coveredTransferableRequirements, 1);
  assert.equal(missed.coverage, .25);
  assert.equal(complete.unsupportedRequirements, 1);
  assert.equal(labelledCoverage([], [{ id: 'unknown', text: 'Unknown', acceptableClaimIds: [] }]).coverage, null);
});

test('optional recruiter findings bind exact bytes and sources but never grant approval', async () => {
  const input = (await fixtures)[0].input, binding = evaluateResume(input).binding;
  const review = { schemaVersion: 1, binding, rubricVersion: 'recruiter-advisory-1', reviewer: 'Synthetic human reviewer', findings: [{
    category: 'clarity', concern: 'Explain what changed for the teams.', claimIds: ['experience.1.claim.1'],
    resumeQuote: 'Owned the analytics enablement program across four product lines', postingQuote: '',
  }] };
  assert.equal(bindRecruiterReview(review, input).approvalGranted, false);
  assert.equal(bindRecruiterReview(review, input).advisoryOnly, true);
  for (const field of ['artifactId', 'artifactHash', 'postingHash', 'postingTextHash', 'claimSnapshotHash'] as const) {
    const changed = structuredClone(review); changed.binding[field] = field.endsWith('Hash') ? '0'.repeat(64) : 'other-artifact';
    assert.throws(() => bindRecruiterReview(changed, input), /stale|another artifact/);
  }
  const invented = structuredClone(review); invented.findings[0].resumeQuote = 'PMP certified';
  assert.throws(() => bindRecruiterReview(invented, input), /quote/);
  const unknown = structuredClone(review); unknown.findings[0].claimIds = ['unknown'];
  assert.throws(() => bindRecruiterReview(unknown, input), /unknown/);
  const uncited = structuredClone(review); uncited.findings[0].resumeQuote = '';
  assert.throws(() => bindRecruiterReview(uncited, input), /Cite/);
});


test('changed posting text invalidates advisory review even if supplied workflow hash is unchanged', async () => {
  const input = structuredClone((await fixtures)[0].input);
  const review = { schemaVersion: 1, binding: evaluateResume(input).binding, rubricVersion: 'recruiter-advisory-1', reviewer: 'Synthetic reviewer', findings: [] };
  input.posting.text += '\nA newly added requirement.';
  assert.throws(() => bindRecruiterReview(review, input), /stale/);
});

test('optional approved search brief is version-bound without inventing approval or preferences', async () => {
  const input = structuredClone((await fixtures)[0].input);
  const identity = { briefId: 'synthetic-approved-brief', version: 1, contentHash: digest('synthetic approved brief') };
  input.approvedSearchBrief = { used: identity, current: { ...identity } };
  const review = { schemaVersion: 1, binding: evaluateResume(input).binding, rubricVersion: 'recruiter-advisory-1', reviewer: 'Synthetic reviewer', findings: [] };
  assert.equal(bindRecruiterReview(review, input).advisoryOnly, true);
  input.approvedSearchBrief.current.version = 2;
  assert.ok(evaluateResume(input).issues.some((i) => i.code === 'stale_search_brief'));
  assert.throws(() => bindRecruiterReview(review, input), /Deterministic/);
});


test('implicit rendered profile and role headers cannot evade approval checks by dropping their snapshots', async () => {
  for (const id of ['profile.name', 'profile.email', 'experience.1.employer', 'experience.1.title', 'experience.1.dates']) {
    const input = structuredClone((await fixtures)[0].input);
    input.manifest.claims = input.manifest.claims.filter((c) => c.id !== id);
    input.currentClaims.find((c) => c.id === id)!.reviewStatus = 'rejected';
    const result = evaluateResume(input);
    assert.equal(result.passed, false, id);
    assert.ok(result.issues.some((i) => ['selected_claim_missing_snapshot', 'rendered_claim_missing_snapshot'].includes(i.code)), id);
  }
});
