import { readFile, rm } from 'node:fs/promises';
import { JobdeskStore } from '../../services/jobdesk/store';
import { createService, initializeService } from '../../services/jobdesk/service';
import { loadSample } from '../../tests/fixtures/sample-resume';
import { tempRoot } from '../../tests/fixtures/temp-root';
import { resumeEvalFixtures } from '../../tests/fixtures/resume-evals';
import { leadIdForUrl } from '../../lib/job-discovery';
import { workflowContext, rankClaims, TEMPLATE_VERSION, type MaterialManifest } from '../../lib/job-workflow';
import { renderResumeDocument } from '../../lib/resume-document';
import { evaluateResume, labelledCoverage, type ResumeEvaluationInput } from '../../lib/resume-evaluation';
import type { ReviewClaim } from '../../lib/resume-truth-review';

/** Reads the saved PDF bytes through an independent parser, not renderer logs. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false });
  try {
    const document = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n), content = await page.getTextContent();
      pages.push(content.items.map((item) => 'str' in item ? item.str : '').join(' '));
    }
    return pages.join('\n');
  } finally { await task.destroy(); }
}

export async function runResumeOutputEvaluation() {
  const root = await tempRoot('resume-eval-');
  const store = await JobdeskStore.open(root);
  const cases: { id: string; input: ResumeEvaluationInput; report: ReturnType<typeof evaluateResume>;
    shortlistBaseline: ReturnType<typeof labelledCoverage> }[] = [];
  try {
    await initializeService(store); await loadSample(store);
    // Synthetic test setup only. Real approvals are deliberately not bypassed.
    await store.sql`UPDATE resume_truth_claims SET review_status='reviewed'`;
    const call = createService(store);
    for (const fixture of resumeEvalFixtures) {
      const url = `https://example.test/jobs/${fixture.id}`, leadId = leadIdForUrl(url);
      await call({ method: 'leads.add', args: [{ url, title: fixture.id, organization: 'Fictional Evaluation Employer' }] });
      await call({ method: 'draft.posting', args: [leadId, fixture.postingText, 'Synthetic posting verified for an offline evaluation fixture.'] });
      const packet: any = await call({ method: 'workflow.packet', args: [{ leadId, stage: 'assessment' }] });
      await call({ method: 'workflow.save', args: [{ packetId: packet.id, inputHash: packet.inputHash, result: {
        recommendation: fixture.recommendation, reasons: [{ text: 'Hand-labelled fixture assessment; no model was called.', evidence: fixture.postingText.split('\n')[0] }],
        uncertainties: fixture.requirements.filter((r) => !r.acceptableClaimIds.length).map((r) => r.id), claimIds: fixture.selectedClaimIds,
      } }] });
      const selection: any = await call({ method: 'workflow.packet', args: [{ leadId, stage: 'selection' }] });
      const saved: any = await call({ method: 'workflow.save', args: [{ packetId: selection.id, inputHash: selection.inputHash, result: {
        template: TEMPLATE_VERSION, sections: [{ kind: 'experience', claimIds: fixture.selectedClaimIds }], outreach: false, unresolved: [],
      } }] });
      if (saved.state !== 'complete') throw new Error(`Fixture ${fixture.id} selection rejected: ${saved.error}`);
      const built: any = await call({ method: 'workflow.build', args: [{ leadId }] });
      if (built.state !== 'current') throw new Error(`Fixture ${fixture.id} did not render.`);
      const [row] = await store.sql`SELECT manifest FROM job_material_manifests WHERE id=${built.id}`;
      const manifest = row.manifest as MaterialManifest;
      const artifact = built.artifacts.find((a: any) => a.kind === 'resume');
      const bytes = await readFile(artifact.path), extractedText = await extractPdfText(bytes);
      const currentClaims = await call({ method: 'truth.list', args: [] }) as ReviewClaim[];
      const context = await store.run((sql) => workflowContext(leadId, sql));
      // A separate re-render exposes its trace for comparison with SAVED PDF bytes.
      const rendered = await renderResumeDocument(manifest, []);
      const input: ResumeEvaluationInput = { manifest, currentClaims,
        posting: { text: fixture.postingText, hash: context.postingHash, verified: true },
        artifact: { id: artifact.id, bytes, expectedHash: artifact.contentHash, extractedText, rendererText: rendered.validation.text },
        oracle: fixture, recommendation: fixture.recommendation };
      cases.push({ id: fixture.id, input, report: evaluateResume(input),
        shortlistBaseline: labelledCoverage(rankClaims(currentClaims, `${fixture.id} ${fixture.postingText}`).slice(0, 8).map((c) => c.id), fixture.requirements) });
      const [draft] = await store.sql`SELECT review_status FROM job_application_drafts WHERE lead_id=${leadId}`;
      if (draft.review_status !== 'review_required' || built.validation.visual !== 'pending') throw new Error('Evaluation must not grant material or submission approval.');
    }
    return cases;
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}
