import { requireJobsAccount } from '@/lib/jobs-auth';
import { listSearchQueries, listSearchStatus } from '@/lib/job-discovery';
import JobsShell from '../jobs-shell';
import { editSearchQueries, runJobSearchNow } from '../actions';
import '../jobs.css';

export const dynamic = 'force-dynamic';
export default async function SettingsPage() {
  await requireJobsAccount();
  const [queries, status] = await Promise.all([listSearchQueries(), listSearchStatus()]);
  return <JobsShell active="settings"><header className="jobsPageHeader"><p className="jobsEyebrow">Discovery</p><h1>Search settings</h1><p>Connect and check your Google Alerts RSS feeds.</p></header>
    <section className="jobsPanel"><h2>Feed status</h2><p>{queries.filter((item: any) => item.feedUrl && item.enabled).length} of {queries.length} feeds connected · {String(status.usage.callsUsed)} of {String(status.usage.callCap)} monthly polls used</p><form action={runJobSearchNow}><button className="jobsButtonPrimary" type="submit">Scan feeds now</button></form><p className="jobsMuted">One successful scan per UTC date. Feed entries are discovery hints, not verified live openings.</p>{status.runs.map((run: any) => <p key={String(run.date)}><strong>{String(run.date).slice(0,10)} · {String(run.status).toUpperCase()}</strong> · {String(run.queriesAttempted)} feeds · {String(run.newLeads)} new leads{run.errorMessage ? ` · ${String(run.errorMessage)}` : ''}</p>)}</section>
    <section className="jobsPanel"><h2>Google Alerts feeds</h2><p>Create or edit alerts at <a href="https://www.google.com/alerts" target="_blank" rel="noreferrer">Google Alerts ↗</a>, set delivery to RSS, and paste each URL here. Editing reference terms below does not change the alert at Google.</p><form action={editSearchQueries}><div className="jobsFormGrid">{queries.map((query: any) => <fieldset key={String(query.id)}><legend>{String(query.lane)} · {String(query.location)}</legend><label>Alert terms (reference)<textarea name={`query:${query.id}`} required minLength={8} maxLength={500} rows={2} defaultValue={String(query.query)} /></label><label>Google Alert RSS URL<input name={`feed:${query.id}`} type="url" defaultValue={String(query.feedUrl ?? '')} /></label><label><input name={`enabled:${query.id}`} type="checkbox" defaultChecked={Boolean(query.enabled)} />Poll this feed daily</label></fieldset>)}</div><p><button className="jobsButtonPrimary" type="submit">Save feed settings</button></p></form></section>
  </JobsShell>;
}
