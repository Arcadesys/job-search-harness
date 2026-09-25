import { requireJobsAccount } from '@/lib/jobs-auth';
import { centralDate, getReviewWeeks, JOB_REVIEW_TIME_ZONE, listReviewLeads, listWeeklyReview } from '@/lib/jobs-review';
import { addReviewEvent, completeReviewWeek } from './actions';
import JobsShell from '../jobs-shell';
import '../jobs.css';

export const dynamic = 'force-dynamic';

const panel: React.CSSProperties = { background: '#1c1c2a', border: '2px solid #77778a', borderRadius: 12, padding: '1.25rem', marginBlock: '1.25rem' };
const field: React.CSSProperties = { display: 'block', width: '100%', minHeight: 54, font: 'inherit', color: '#fff', background: '#10101a', border: '2px solid #aaaabd', borderRadius: 8, padding: '0.6rem 0.75rem', marginBlock: '0.35rem 0.8rem' };
const button: React.CSSProperties = { minHeight: 56, padding: '0.6rem 1rem', font: 'inherit', fontWeight: 700, color: '#10101a', background: '#fff', border: '3px solid #fff', borderRadius: 8, cursor: 'pointer' };
const stats: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: '0.75rem' };
const label: React.CSSProperties = { display: 'block', fontWeight: 700, marginTop: '0.4rem' };
const metrics = [
  ['leads', 'Leads discovered'], ['kept', 'Roles kept'], ['applications', 'Applications'],
  ['replies', 'Replies'], ['interviews', 'Interviews'], ['offers', 'Offers'],
] as const;
const addDays = (date: string, days: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

export default async function WeeklyReviewPage() {
  await requireJobsAccount();
  const weeks = getReviewWeeks(centralDate(), 8);
  const [rows, leads] = await Promise.all([listWeeklyReview(weeks), listReviewLeads()]);
  const byWeek = new Map(rows.map((row: any) => [String(row.weekStart).slice(0, 10), row]));

  return <JobsShell active="review">
    <header className="jobsPageHeader">
      <p className="jobsEyebrow">Activity</p>
      <h1>Weekly review</h1>
      <p>Weeks run Monday through Sunday in Central Time ({JOB_REVIEW_TIME_ZONE}). Reporting window: {weeks[0]} through {addDays(weeks.at(-1)!, 6)}.</p>
      <p>Leads discovered come from dated lead records. Keeps and outcomes count only dated events you record. An open week shows unrecorded outcomes as unknown; mark it reviewed after recording all known activity to make zero an explicit zero.</p>
    </header>

    <section aria-labelledby="record-activity" style={panel}>
      <h2 id="record-activity">Record dated activity</h2>
      <p>Record only what happened, with the date you know. Reply, interview, and offer events are never inferred from application stages or time passed.</p>
      <form action={addReviewEvent} style={stats}>
        <label style={label}>Lead<select name="leadId" required defaultValue="" style={field}><option value="" disabled>Choose a lead</option>{leads.map((lead: any) => <option key={String(lead.id)} value={String(lead.id)}>{String(lead.title)}{lead.organization ? ` — ${String(lead.organization)}` : ''}</option>)}</select></label>
        <label style={label}>Activity<select name="type" required defaultValue="application" style={field}><option value="kept">Role kept</option><option value="application">Application sent</option><option value="reply">Reply received</option><option value="interview">Interview held</option><option value="offer">Offer received</option></select></label>
        <label style={label}>Date<input name="date" type="date" required defaultValue={centralDate()} style={field} /></label>
        <label style={label}>Note (optional)<input name="note" maxLength={1000} style={field} /></label>
        <div><button type="submit" style={button}>Record activity</button></div>
      </form>
    </section>

    <section aria-labelledby="weekly-counts">
      <h2 id="weekly-counts">Weekly counts</h2>
      <div style={{ display: 'grid', gap: '1rem' }}>{weeks.slice().reverse().map((week) => {
        const row = byWeek.get(week) ?? { leads: 0, kept: 0, applications: 0, replies: 0, interviews: 0, offers: 0, reviewedAt: null };
        const complete = Boolean(row.reviewedAt);
        return <article key={week} style={panel}>
          <h3 style={{ marginTop: 0 }}>Week of {week} <span style={{ fontSize: '1rem', fontWeight: 400 }}>through {addDays(week, 6)}</span></h3>
          <p><strong>Outcome review:</strong> {complete ? `Reviewed ${new Date(String(row.reviewedAt)).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: JOB_REVIEW_TIME_ZONE })}` : 'Open; outcome totals may be incomplete.'}</p>
          <dl style={stats}>{metrics.map(([key, title]) => {
            const count = Number(row[key]);
            const value = key === 'leads' || complete ? String(count) : count ? `${count} recorded; review open` : 'Not recorded';
            return <div key={key} style={{ border: '1px solid #aaaabd', borderRadius: 8, padding: '0.75rem' }}><dt style={{ fontWeight: 700 }}>{title}</dt><dd style={{ margin: 0, fontSize: '1.4rem' }}>{value}</dd></div>;
          })}</dl>
          {!complete ? <form action={completeReviewWeek} style={{ marginTop: '1rem' }}><input type="hidden" name="weekStart" value={week} /><button type="submit" style={button}>Mark this week reviewed</button></form> : null}
        </article>;
      })}</div>
    </section>
  </JobsShell>;
}
