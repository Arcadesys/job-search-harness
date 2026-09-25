import { requireJobsAccount } from '@/lib/jobs-auth';
import { listResumeTruth } from '@/lib/resume-truth';
import JobsShell from '../jobs-shell';
import TruthEditor from '../truth-editor';
import '../jobs.css';

export const dynamic = 'force-dynamic';
export default async function TruthsPage() {
  await requireJobsAccount();
  const claims = await listResumeTruth();
  const reviewed = claims.filter((claim: any) => claim.reviewStatus === 'reviewed').length;
  const unreviewed = claims.filter((claim: any) => claim.reviewStatus === 'unreviewed').length;
  return <JobsShell active="truths"><header className="jobsPageHeader"><p className="jobsEyebrow">Your evidence</p><h1>Résumé truths</h1><p>Review facts and source notes before using them in a draft.</p></header>
    <dl className="jobsTruthStats"><div><dt>Reviewed</dt><dd>{reviewed}</dd></div><div><dt>Unreviewed</dt><dd>{unreviewed}</dd></div><div><dt>Rejected</dt><dd>{claims.length - reviewed - unreviewed}</dd></div></dl>
    <TruthEditor claims={claims as any} />
    <section className="jobsPanel" style={{ marginTop: '1rem' }}><h2>Drafting packet</h2><p>Download pursued leads with reviewed claims and their source notes. Public résumé changes require separate review.</p><a className="jobsActionLink" href="/api/jobs/drafting-export" download>Download private drafting packet (JSON)</a></section>
  </JobsShell>;
}
