import { sampleClaims } from './sample-resume';
import { resumeEvalFixtures } from './resume-evals';
import { makeMaterialManifest, TEMPLATE_VERSION, type WorkflowContext } from '../../lib/job-workflow';
import { renderResumeDocument } from '../../lib/resume-document';
import { digest, evaluateResume, type ResumeEvaluationInput } from '../../lib/resume-evaluation';
import { extractPdfText } from '../../scripts/evals/resume-output';

/** Store-free detector tests use the real assembler/renderer/parser. The separate
 * service test exercises saved PDFs and the approval gates in a real test store. */
export async function renderResumeEvalFixtures() {
  return Promise.all(resumeEvalFixtures.map(async (fixture) => {
    const claims = sampleClaims().map((claim) => ({ ...claim, reviewStatus: 'reviewed' as const, version: 'synthetic-version-1' }));
    const postingHash = digest(fixture.postingText);
    const context: WorkflowContext = {
      lead: { id: fixture.id, title: fixture.id, organization: 'Fictional Evaluation Employer', verificationStatus: 'verified' },
      posting: fixture.postingText, postingHash, catalogHash: 'synthetic-catalog',
      settings: { preferences: '', currency: 'USD', excludedEmployers: [], excludedLocations: [], links: [] },
      claims, assessment: {}, assessmentHash: 'synthetic-assessment', selectionHash: 'synthetic-selection', source: {}, tailoringInstructions: '',
    };
    const manifest = makeMaterialManifest({ template: TEMPLATE_VERSION, sections: [{ kind: 'experience', claimIds: fixture.selectedClaimIds }], outreach: false, unresolved: [] }, context);
    const rendered = await renderResumeDocument(manifest, []);
    const input: ResumeEvaluationInput = { manifest, currentClaims: claims,
      posting: { text: fixture.postingText, hash: postingHash, verified: true },
      artifact: { id: fixture.id, bytes: rendered.bytes, expectedHash: digest(rendered.bytes), extractedText: await extractPdfText(rendered.bytes), rendererText: rendered.validation.text },
      oracle: fixture, recommendation: fixture.recommendation };
    return { id: fixture.id, input, report: evaluateResume(input) };
  }));
}
