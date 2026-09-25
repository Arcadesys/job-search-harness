import Link from 'next/link';
import { requireJobsAccount } from '@/lib/jobs-auth';
import { listLeads } from '@/lib/job-discovery';
import JobsShell from '../jobs-shell';
import { addJobLead, updateJobLead } from '../actions';
import BatchSelector from '../batch-selector';
import ApplicationBatches from '../application-batches';
import { listApplicationBatches, listEligiblePursuedLeads } from '@/lib/job-queue';
import '../jobs.css';

export const dynamic = 'force-dynamic';
const dateText = (value: unknown) => value ? new Date(String(value)).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Chicago' }) : 'Unknown';
export default async function LeadsPage() {
  const ownerId = await requireJobsAccount();
  const [leads, batches, eligible] = await Promise.all([listLeads(), listApplicationBatches(ownerId), listEligiblePursuedLeads(ownerId)]);
  return <JobsShell active="leads">
    <header className="jobsPageHeader"><p className="jobsEyebrow">Pipeline</p><h1>Leads</h1><p>Search results stay unverified until you open the original posting.</p></header>
    <BatchSelector leads={eligible.map((lead: any) => ({ id: String(lead.id), title: String(lead.title), organization: String(lead.organization ?? '') }))} pursuedCount={leads.filter((lead: any) => lead.decision === 'keep').length} />
    <ApplicationBatches batches={batches as any} />
    <section className="jobsPanel" id="add-lead" aria-labelledby="add-heading"><h2 id="add-heading">Add a job URL</h2><form action={addJobLead} className="jobsFormGrid">
      <label>Posting URL<input name="url" type="url" required /></label><label>Role title<input name="title" required maxLength={250} /></label><label>Organization<input name="organization" maxLength={200} /></label><label>Location<input name="location" maxLength={160} /></label><label style={{ gridColumn: '1 / -1' }}>Notes<textarea name="notes" maxLength={4000} rows={2} /></label><div><button className="jobsButtonPrimary" type="submit">Save unverified lead</button></div>
    </form></section>
    <section aria-labelledby="pipeline-heading"><h2 id="pipeline-heading">Pipeline · {leads.length} leads</h2>{leads.length ? <div className="jobsLeadList">{leads.map((lead: any) => <article key={String(lead.id)} className="jobsLeadCard"><h3><Link href={`/jobs/${encodeURIComponent(String(lead.id))}`}>{String(lead.title)}</Link></h3><div className="jobsLeadMeta"><span>{String(lead.organization || 'Organization unknown')}</span><span className="jobsStatus">{lead.decision === 'keep' ? 'Pursue' : String(lead.decision)}</span><span className="jobsStatus">{String(lead.verificationStatus)}</span><span>{String(lead.source).startsWith('linkedin-email') ? 'LinkedIn email alert' : String(lead.source).startsWith('google-alerts') ? 'Google Alert' : 'Added manually'}</span><span>{dateText(lead.discoveredAt)}</span></div><p><a href={String(lead.sourceUrl)} target="_blank" rel="noreferrer">Open original posting ↗</a></p>{lead.snippet ? <p className="jobsMuted">{String(lead.snippet)}</p> : null}
      <form action={updateJobLead} className="jobsFormGrid"><input type="hidden" name="id" value={String(lead.id)} /><label>Decision<select name="decision" defaultValue={String(lead.decision)}><option value="review">Review</option><option value="keep">Pursue</option><option value="pass">Pass</option></select></label><label>Posting status<select name="verification" defaultValue={String(lead.verificationStatus)}><option value="unverified">Unverified</option><option value="verified">Verified by opening link</option><option value="stale">Stale</option><option value="unavailable">Unavailable</option></select></label><label>Application stage<select name="stage" defaultValue={String(lead.applicationStage ?? '')}><option value="">Not in pipeline</option><option value="researching">Researching</option><option value="preparing">Preparing</option><option value="applied">Applied</option><option value="interviewing">Interviewing</option><option value="offer">Offer</option><option value="closed">Closed</option></select></label><label>Next action<input name="nextAction" maxLength={500} defaultValue={String(lead.nextAction ?? '')} /></label><label>Next action date<input name="nextActionDate" type="date" defaultValue={String(lead.nextActionDate ?? '').slice(0,10)} /></label><label>Notes<textarea name="notes" rows={2} maxLength={4000} defaultValue={String(lead.notes ?? '')} /></label><div><button type="submit">Save pipeline</button></div></form>
    </article>)}</div> : <div className="jobsPanel jobsEmpty"><h3>No leads yet</h3><p>Add a posting above or scan connected feeds from <Link href="/jobs">Today</Link>.</p></div>}</section>
  </JobsShell>;
}
