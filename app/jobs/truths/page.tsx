import { requireJobsAccount } from '@/lib/jobs-auth';
import { listResumeTruth } from '@/lib/resume-truth';
import JobsShell from '../jobs-shell';
import TruthEditor from '../truth-editor';
import '../jobs.css';

export const dynamic = 'force-dynamic';
export default async function TruthsPage() {
  await requireJobsAccount();
  const claims = await listResumeTruth();
  return <JobsShell active="truths" truthReview>
    <TruthEditor claims={claims} />
    <section className="jobsPanel" style={{ marginTop: '1rem' }}><h2>Drafting packet</h2><p>Download pursued leads with reviewed claims and their source notes. Public résumé changes require separate review.</p><a className="jobsActionLink" href="/api/jobs/drafting-export" download>Download private drafting packet (JSON)</a></section>
  </JobsShell>;
}
