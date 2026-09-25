import { authorizedJobsAccount, requireJobsAccount } from '@/lib/jobs-auth';
import { listLeads, listSearchQueries, listSearchStatus } from '@/lib/job-discovery';
import { listResumeTruth } from '@/lib/resume-truth';
import { centralDate } from '@/lib/jobs-review';
import { signIn } from '@/auth';
import Link from 'next/link';
import JobsShell from './jobs-shell';
import { runJobSearchNow } from './actions';
import './jobs.css';

export const dynamic = 'force-dynamic';
const dateText = (value: unknown) => value ? new Date(String(value)).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Chicago' }) : 'Not run yet';

export default async function JobsPage() {
  const accountId = await authorizedJobsAccount();
  if (!accountId) {
    async function signInWithGithub() { 'use server'; await signIn('github', { redirectTo: '/jobs' }); }
    return <main className="jobsWorkspace" style={{ minHeight: '100vh', padding: 'clamp(1rem,6vw,4rem)' }}><section className="jobsPanel" style={{ maxWidth: 650, margin: '0 auto' }}><h1>Private job workspace</h1><p>Sign in with the GitHub account authorized for this workspace.</p><form action={signInWithGithub}><button className="jobsButtonPrimary" type="submit">Sign in with GitHub</button></form></section></main>;
  }
  await requireJobsAccount();
  let reads;
  let storageError = '';
  try { reads = await Promise.all([listSearchQueries(), listSearchStatus(), listLeads(), listResumeTruth()]); }
  catch (error) { storageError = error instanceof Error ? error.message : 'Private storage is unavailable.'; }
  const [queries = [], status, leads = [], truths = []] = reads ?? [];
  const decisions = leads.filter((lead: any) => lead.decision === 'review').length;
  const kept = leads.filter((lead: any) => lead.decision === 'keep').length;
  const today = centralDate();
  const due = leads.filter((lead: any) => lead.nextActionDate && String(lead.nextActionDate).slice(0, 10) <= today && lead.decision !== 'pass').length;
  const unreviewed = truths.filter((claim: any) => claim.reviewStatus === 'unreviewed').length;
  const connected = queries.filter((query: any) => query.enabled && query.feedUrl).length;
  const lastRun = status?.runs?.[0];
  return <JobsShell active="today">
    <header className="jobsPageHeader"><p className="jobsEyebrow">Your workspace</p><h1>Today</h1><p>Review new opportunities and choose your next move.</p></header>
    {storageError ? <section className="jobsPanel" role="status"><h2>Private database unavailable</h2><p>{storageError}</p></section> : <div className="jobsDashboard">
      <div className="jobsPrimary">
        <dl className="jobsStats">
          <div className="jobsStat"><dt>Leads in inbox</dt><dd>{leads.length}</dd><p>{kept} kept</p></div>
          <div className="jobsStat"><dt>Need a decision</dt><dd>{decisions}</dd><p>Review or pass</p></div>
          <div className="jobsStat"><dt>Follow-ups due</dt><dd>{due}</dd><p>Due today or earlier</p></div>
        </dl>
        <div className="jobsActions"><Link className="jobsActionLink jobsButtonPrimary" href="/jobs/leads#add-lead">Add a job URL →</Link><form action={runJobSearchNow}><button type="submit" style={{ width: '100%', height: '100%' }}>Scan feeds now →</button></form></div>
        <section className="jobsPanel" aria-labelledby="inbox-heading"><h2 id="inbox-heading">Lead inbox</h2>
          {leads.length ? <div className="jobsLeadList">{leads.slice(0, 6).map((lead: any) => <article className="jobsLeadCard" key={String(lead.id)}><h3><Link href={`/jobs/${encodeURIComponent(String(lead.id))}`}>{String(lead.title)}</Link></h3><div className="jobsLeadMeta"><span>{String(lead.organization || 'Organization unknown')}</span><span className="jobsStatus">{String(lead.decision)}</span><span className="jobsStatus">{String(lead.verificationStatus)}</span><span>{String(lead.source).startsWith('linkedin-email') ? 'LinkedIn email alert' : String(lead.source).startsWith('google-alerts') ? 'Google Alert' : 'Added manually'}</span></div></article>)}</div> : <div className="jobsEmpty"><h3>No leads yet</h3><p>Add a job URL or scan your connected feeds to start collecting opportunities.</p><Link href="/jobs/leads#add-lead">Add a job URL →</Link></div>}
          {leads.length ? <p><Link href="/jobs/leads">View all leads and pipeline →</Link></p> : null}
        </section>
      </div>
      <aside className="jobsNext" aria-label="Next steps and scan status">
        <section className="jobsPanel"><h2>Next up</h2><Link className="jobsNextLink" href="/jobs/truths" id="drafting-handoff"><strong>Review résumé truths →</strong><span>{unreviewed} unreviewed · {truths.length - unreviewed} with another status</span></Link><Link className="jobsNextLink" href="/jobs/settings"><strong>Google Alerts →</strong><span>{connected} of {queries.length} feeds connected</span></Link><Link className="jobsNextLink" href="/jobs/review"><strong>Weekly review →</strong><span>Record applications and outcomes</span></Link></section>
        <section className="jobsPanel" aria-labelledby="scan-heading"><h2 id="scan-heading">Last scan</h2><p><strong>{lastRun ? String(lastRun.status).toUpperCase() : 'Not run yet'}</strong> · {dateText(lastRun?.startedAt)}</p><p>{lastRun ? `${String(lastRun.queriesAttempted)} feeds polled · ${String(lastRun.newLeads)} new leads` : 'Run a scan when your feeds are ready.'}</p>{lastRun?.errorMessage ? <p role="status"><strong>Scan issue:</strong> {String(lastRun.errorMessage)}</p> : null}<p className="jobsMuted">{String(status?.usage?.callsUsed ?? 0)} of {String(status?.usage?.callCap ?? 300)} monthly feed polls used.</p></section>
      </aside>
    </div>}
  </JobsShell>;
}
