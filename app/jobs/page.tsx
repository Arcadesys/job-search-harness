import { authorizedJobsAccount, requireJobsAccount } from '@/lib/jobs-auth';
import { listLeads, listSearchQueries, listSearchStatus } from '@/lib/job-discovery';
import { listResumeTruth } from '@/lib/resume-truth';
import { signIn } from '@/auth';
import Link from 'next/link';
import TruthEditor from './truth-editor';
import { addJobLead, editSearchQueries, runJobSearchNow, updateJobLead } from './actions';
import './jobs.css';

export const dynamic = 'force-dynamic';

const pageStyle: React.CSSProperties = { maxWidth: 1120, margin: '0 auto', padding: '2rem clamp(1rem, 4vw, 3rem)', fontSize: '1.125rem', lineHeight: 1.55, color: '#f7f7fb', background: '#10101a', minHeight: '100vh' };
const panel: React.CSSProperties = { background: '#1c1c2a', border: '2px solid #77778a', borderRadius: 12, padding: '1.25rem', marginBlock: '1.25rem' };
const field: React.CSSProperties = { display: 'block', width: '100%', minHeight: 54, font: 'inherit', color: '#fff', background: '#10101a', border: '2px solid #aaaabd', borderRadius: 8, padding: '0.6rem 0.75rem', marginBlock: '0.35rem 0.8rem' };
const button: React.CSSProperties = { minHeight: 56, padding: '0.6rem 1rem', font: 'inherit', fontWeight: 700, color: '#10101a', background: '#fff', border: '3px solid #fff', borderRadius: 8, cursor: 'pointer' };
const columns: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '1rem' };
const labelStyle: React.CSSProperties = { display: 'block', fontWeight: 700, marginTop: '0.4rem' };
const dateText = (v: unknown) => v ? new Date(String(v)).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Chicago' }) : 'Not run yet';

export default async function JobsPage() {
  const accountId = await authorizedJobsAccount();
  if (!accountId) {
    async function signInWithGithub() { 'use server'; await signIn('github', { redirectTo: '/jobs' }); }
    return <main className="jobsWorkspace" style={pageStyle}><section style={panel}><h1>Private job workspace</h1><p>Sign in with the GitHub account authorized for this workspace.</p><form action={signInWithGithub}><button style={button} type="submit">Sign in with GitHub</button></form></section></main>;
  }
  await requireJobsAccount();
  let reads;
  let storageError = '';
  try {
    reads = await Promise.all([listSearchQueries(), listSearchStatus(), listLeads(), listResumeTruth()]);
  } catch (error) {
    storageError = error instanceof Error ? error.message : 'Private storage is unavailable.';
  }
  const [queries = [], status, leads = [], truth = []] = reads ?? [];

  return <main className="jobsWorkspace" style={pageStyle}>
    <header style={{ borderBottom: '3px solid #fff', paddingBottom: '1rem' }}>
      <p style={{ margin: 0, fontWeight: 700, letterSpacing: '0.04em' }}>PRIVATE WORKSPACE · GITHUB ACCOUNT {accountId}</p>
      <h1 style={{ fontSize: 'clamp(2.25rem, 6vw, 3.5rem)', lineHeight: 1.1, marginBlock: '0.5rem' }}>Job search desk</h1>
      <p>Search results are leads only. Open the original posting before treating its details as verified.</p>
      <nav aria-label="Private job workspace"><Link href="/jobs/review">Weekly review →</Link> · <a href="#drafting-handoff">Résumé truths ↓</a> · <a href="#inbox">Lead inbox ↓</a></nav>
    </header>
    {storageError ? <section role="status" style={panel}><h2>Private database unavailable</h2><p>{storageError}</p></section> : <>
      <section aria-labelledby="run-status" style={panel}>
        <h2 id="run-status">Daily Google Alerts status</h2>
        <p><strong>This month:</strong> {String(status?.usage?.callsUsed ?? 0)} of {String(status?.usage?.callCap ?? 300)} feed polls used</p>
        <form action={runJobSearchNow} style={{ marginBlock: '1rem' }}><button type="submit" style={button}>Scan feeds now</button><span style={{ marginInlineStart: '0.75rem' }}>One successful scan per UTC date; a failed scan can be retried.</span></form>
        <div style={columns}>{(status?.runs ?? []).map((run: any) => <div key={String(run.date)} style={{ border: '1px solid #aaaabd', borderRadius: 8, padding: '0.75rem' }}>
          <strong>{String(run.date)} · {String(run.status).toUpperCase()}</strong><br />Started {dateText(run.startedAt)}<br />Queries {String(run.queriesAttempted)} · leads {String(run.newLeads)} · calls {String(run.callsUsed)}
          {run.errorMessage ? <p role="status"><strong>Failure:</strong> {String(run.errorMessage)}</p> : null}
        </div>)}</div>
      </section>

      <section aria-labelledby="add-lead" style={panel}>
        <h2 id="add-lead">Add a lead from a URL</h2>
        <p>Save a source URL manually. New leads begin as unverified and need an open-link check.</p>
        <form action={addJobLead} style={columns}>
          <label style={labelStyle}>Posting URL<input name="url" type="url" required style={field} /></label>
          <label style={labelStyle}>Role title<input name="title" required maxLength={250} style={field} /></label>
          <label style={labelStyle}>Organization<input name="organization" maxLength={200} style={field} /></label>
          <label style={labelStyle}>Location<input name="location" maxLength={160} style={field} /></label>
          <label style={{ ...labelStyle, gridColumn: '1 / -1' }}>Notes<textarea name="notes" maxLength={4000} rows={3} style={field} /></label>
          <div><button type="submit" style={button}>Save unverified lead</button></div>
        </form>
      </section>

      <section aria-labelledby="queries" style={panel}>
        <h2 id="queries">Google Alerts feeds</h2>
        <p>Create six alerts at <a href="https://www.google.com/alerts" target="_blank" rel="noreferrer">Google Alerts ↗</a>, set each delivery to RSS, and paste its feed URL below. The terms here are a reference; changing them here does not edit the matching Google Alert. Feed entries are discovery hints, not verified openings.</p>
        <form action={editSearchQueries}>
          <div style={columns}>{queries.map((query: any) => <fieldset key={String(query.id)} style={{ border: '1px solid #aaaabd', borderRadius: 8, padding: '0.75rem' }}>
            <legend style={{ fontWeight: 700 }}>{String(query.lane)} · {String(query.location)}</legend>
            <label style={labelStyle}>Alert terms (reference)<textarea name={`query:${query.id}`} required minLength={8} maxLength={500} rows={3} defaultValue={String(query.query)} style={field} /></label>
            <label style={labelStyle}>Google Alert RSS URL<input name={`feed:${query.id}`} type="url" placeholder="https://www.google.com/alerts/feeds/…" defaultValue={String(query.feedUrl ?? '')} style={field} /></label>
            <label style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', minHeight: 48 }}><input name={`enabled:${query.id}`} type="checkbox" defaultChecked={Boolean(query.enabled)} style={{ width: 24, height: 24 }} />Poll this feed daily</label>
          </fieldset>)}</div>
          <button type="submit" style={button}>Save Google Alerts feeds</button>
        </form>
      </section>

      <section aria-labelledby="inbox" style={panel}>
        <h2 id="inbox">Lead inbox and application pipeline</h2>
        {leads.length === 0 ? <p>No leads yet. The daily search run or a manual URL can add the first one.</p> : <div style={{ display: 'grid', gap: '1rem' }}>{leads.map((lead: any) => <article key={String(lead.id)} style={{ ...panel, margin: 0 }}>
          <h3 style={{ marginTop: 0 }}>{String(lead.title)}</h3>
          <p><a href={`/jobs/${encodeURIComponent(String(lead.id))}`}>Open private assessment and drafting page →</a></p>
          <p><strong>{String(lead.organization || 'Organization not listed')}</strong>{lead.location ? ` · ${String(lead.location)}` : ''}</p>
          <p><strong>Source:</strong> {String(lead.source)} · <strong>Decision:</strong> {String(lead.decision)} · <strong>Posting:</strong> {String(lead.verificationStatus)}</p>
          <p><strong>Discovered:</strong> {dateText(lead.discoveredAt)} · <strong>Last surfaced or added:</strong> {dateText(lead.lastCheckedAt)}</p>
          {lead.snippet ? <p>{String(lead.snippet)}</p> : null}
          <p><a href={String(lead.sourceUrl)} target="_blank" rel="noreferrer" style={{ color: '#fff', textDecoration: 'underline', textUnderlineOffset: 4 }}>Open original posting ↗</a></p>
          <form action={updateJobLead}>
            <input type="hidden" name="id" value={String(lead.id)} />
            <div style={columns}>
              <label style={labelStyle}>Decision<select name="decision" defaultValue={String(lead.decision)} style={field}><option value="review">Review</option><option value="keep">Keep</option><option value="pass">Pass</option></select></label>
              <label style={labelStyle}>Posting status<select name="verification" defaultValue={String(lead.verificationStatus)} style={field}><option value="unverified">Unverified</option><option value="verified">Verified by opening link</option><option value="stale">Stale</option><option value="unavailable">Unavailable</option></select></label>
              <label style={labelStyle}>Application stage<select name="stage" defaultValue={String(lead.applicationStage ?? '')} style={field}><option value="">Not in application pipeline</option><option value="researching">Researching</option><option value="preparing">Preparing</option><option value="applied">Applied</option><option value="interviewing">Interviewing</option><option value="offer">Offer</option><option value="closed">Closed</option></select></label>
              <label style={labelStyle}>Next action<input name="nextAction" maxLength={500} defaultValue={String(lead.nextAction ?? '')} style={field} /></label>
              <label style={labelStyle}>Next action date<input name="nextActionDate" type="date" defaultValue={String(lead.nextActionDate ?? '').slice(0, 10)} style={field} /></label>
              <label style={labelStyle}>Notes<textarea name="notes" rows={2} maxLength={4000} defaultValue={String(lead.notes ?? '')} style={field} /></label>
            </div>
            <button type="submit" style={button}>Save lead and pipeline</button>
          </form>
        </article>)}</div>}
      </section>

      <section aria-labelledby="drafting-handoff" style={panel}>
        <h2 id="drafting-handoff">Drafting handoff</h2>
        <p>Download kept job leads with reviewed resume claims and their source notes. Unreviewed claims are omitted from the drafting packet.</p>
        <a href="/api/jobs/drafting-export" download style={{ display: 'inline-block', minHeight: 54, padding: '0.6rem 1rem', border: '3px solid #fff', borderRadius: 8, fontWeight: 700 }}>Download private drafting packet (JSON)</a>
        <h3>Resume truth review status</h3>
        <p>{String(truth.filter((claim: any) => claim.reviewStatus === 'reviewed').length)} reviewed · {String(truth.filter((claim: any) => claim.reviewStatus === 'unreviewed').length)} unreviewed · {String(truth.filter((claim: any) => claim.reviewStatus === 'rejected').length)} rejected</p>
        <p>Claims remain sourced to lib/resume.ts and are not used as public resume edits.</p>
        <TruthEditor claims={truth} />
      </section>
    </>}
    <p style={{ fontSize: '1rem', borderTop: '1px solid #aaaabd', paddingTop: '1rem' }}>Private job search data stays inside this authenticated workspace. Search snippets do not verify a posting.</p>
  </main>;
}
