import { startJobdesk } from '../../services/jobdesk/server';
import { sampleResume } from './sample-resume';
import { runCollection } from '../../lib/job-collection';
import { leadIdForUrl } from '../../lib/job-discovery';
import { TEMPLATE_VERSION } from '../../lib/job-workflow';

async function main() {
  const root = process.env.JOBDESK_TEST_ROOT;
  if (!root) throw new Error('Private test root required.');
  const runtime = await startJobdesk({ root });
  const call = runtime.service;
  await call({ method: 'truth.importResume', args: [sampleResume] });
  await runtime.store.sql`UPDATE resume_truth_claims SET review_status='reviewed'`;
  const url = 'https://www.builtinchicago.org/job/fixture-program-manager/123';
  const posting = 'Lead cross-functional programs and analytics enablement. '.repeat(12);
  await runCollection({ source: 'builtin', urls: [] }, runtime.store, { delayMs: 0, fetcher: async (address) => {
    if (String(address).endsWith('/jobs')) return new Response('<main><a href="/job/fixture-program-manager/123">Program manager</a><a href="/job/fixture-unavailable/456">Other</a></main>');
    if (String(address).endsWith('/456')) return new Response('Unavailable fixture', { status: 503 });
    return new Response(`<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Program Manager', description: posting,
      hiringOrganization: { name: 'Fictional Employer' } })}</script>`);
  } });
  const leadId = leadIdForUrl(url);
  await call({ method: 'draft.posting', args: [leadId, posting, 'Verified original posting in synthetic browser fixture.'] });
  await call({ method: 'workflow.configure', args: [{ links: [{ label: 'Build notes', url: 'https://example.test/build-notes' }] }] });
  const assessment: any = await call({ method: 'workflow.packet', args: [{ leadId, stage: 'assessment' }] });
  await call({ method: 'workflow.save', args: [{ packetId: assessment.id, inputHash: assessment.inputHash,
    result: { recommendation: 'candidate', reasons: [{ text: 'Relevant program experience', evidence: 'cross-functional programs' }], uncertainties: [], claimIds: ['experience.1.claim.1'] } }] });
  const selection: any = await call({ method: 'workflow.packet', args: [{ leadId, stage: 'selection' }] });
  await call({ method: 'workflow.save', args: [{ packetId: selection.id, inputHash: selection.inputHash,
    result: { template: TEMPLATE_VERSION, sections: [{ kind: 'experience', claimIds: ['experience.1.claim.1', 'experience.1.claim.2'] }, { kind: 'skills', claimIds: ['skills.1'] }], unresolved: [], outreach: true } }] });
  const material: any = await call({ method: 'workflow.build', args: [{ leadId }] });
  await call({ method: 'workflow.configure', args: [{ excludedEmployers: ['Fictional Employer'], links: [{ label: 'Build notes', url: 'https://example.test/build-notes' }] }] });
  console.log(JSON.stringify({ origin: runtime.origin, socketPath: runtime.socketPath, leadId, material }));
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; await runtime.close(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
