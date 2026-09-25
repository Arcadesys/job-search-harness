import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authorizedJobsAccount } from '@/lib/jobs-auth';
import { getDraftingLead, currentAiUsage, listDraftingHistory } from '@/lib/job-drafting';
import { listResumeTruth } from '@/lib/resume-truth';
import DraftingPanel from './panel';

export const dynamic = 'force-dynamic';
export default async function JobDetail({ params }: { params: Promise<{ id: string }> }) {
  const account = await authorizedJobsAccount();
  if (!account) redirect('/api/auth/signin?callbackUrl=%2Fjobs');
  const { id } = await params;
  const [lead, history, usage, claims] = await Promise.all([getDraftingLead(id), listDraftingHistory(id), currentAiUsage(), listResumeTruth()]);
  if (!lead) return <main className="jobsWorkspace"><h1>Lead not found</h1><Link href="/jobs">Return to job desk</Link></main>;
  return <main className="jobsWorkspace" style={{ maxWidth: 1000, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh', fontSize: '1.125rem' }}>
    <p><Link href="/jobs">← Job desk</Link></p>
    <h1>{String(lead.title)}</h1><p><strong>{String(lead.organization || 'Organization not listed')}</strong> · {String(lead.location || 'Location not listed')}</p>
    <p>Posting status: <strong>{String(lead.verificationStatus)}</strong></p>
    <p><a href={String(lead.sourceUrl)} target="_blank" rel="noreferrer">Open original posting ↗</a></p>
    <DraftingPanel lead={lead as any} history={history as any} usage={usage} claims={claims} />
  </main>;
}
