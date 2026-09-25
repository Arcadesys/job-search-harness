import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authorizedJobsAccount } from '@/lib/jobs-auth';
import { getDraftingLead, currentAiUsage, listDraftingHistory } from '@/lib/job-drafting';
import { listResumeTruth } from '@/lib/resume-truth';
import DraftingPanel from './panel';
import JobsShell from '../jobs-shell';
import '../jobs.css';

export const dynamic = 'force-dynamic';
export default async function JobDetail({ params }: { params: Promise<{ id: string }> }) {
  const account = await authorizedJobsAccount();
  if (!account) redirect('/api/auth/signin?callbackUrl=%2Fjobs');
  const { id } = await params;
  const [lead, history, usage, claims] = await Promise.all([getDraftingLead(id), listDraftingHistory(id), currentAiUsage(), listResumeTruth()]);
  if (!lead) return <JobsShell active="leads"><h1>Lead not found</h1><Link href="/jobs/leads">Return to leads</Link></JobsShell>;
  return <JobsShell active="leads">
    <header className="jobsPageHeader"><p className="jobsEyebrow">Lead detail</p><h1>{String(lead.title)}</h1><p><strong>{String(lead.organization || 'Organization not listed')}</strong> · {String(lead.location || 'Location not listed')}</p></header>
    <p>Posting status: <strong>{String(lead.verificationStatus)}</strong></p>
    <p><a href={String(lead.sourceUrl)} target="_blank" rel="noreferrer">Open original posting ↗</a></p>
    <DraftingPanel lead={lead as any} history={history as any} usage={usage} claims={claims} />
  </JobsShell>;
}
