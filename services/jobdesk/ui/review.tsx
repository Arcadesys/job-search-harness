import { PageHead, type Pipeline, type Run } from './common';

const field = (form: HTMLFormElement, name: string) => String(new FormData(form).get(name) ?? '').trim();
const weekLabel = (iso: string) => new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function WeeklyReview({ data, pipeline, run, busy }: { data: any; pipeline: Pipeline; run: Run; busy: boolean }) {
  const weeks: any[] = data.weeks;
  const chart = [...weeks].reverse();
  const max = Math.max(1, ...chart.map((week) => week.applications));
  const funnel = [['Leads saved', pipeline.funnel.leads], ['Assessed', pipeline.funnel.assessed], ['Chosen', pipeline.funnel.chosen],
    ['Approved drafts', pipeline.funnel.approved], ['Confirmed receipts', pipeline.funnel.receipts]] as const;
  const top = Math.max(1, pipeline.funnel.leads);
  return <>
    <PageHead title="Weekly review" description="Confirmed receipts and user reports remain separate. Totals count receipts only." />
    <section className="ck-grid">
      <div className="ck-card">
        <div className="ck-card-head"><h2>Confirmed applications by week</h2><span className="ck-muted" style={{ fontSize: '1rem' }}>{data.timeZone ?? ''}</span></div>
        <div className="ck-chart" role="img" aria-label={`Confirmed applications, oldest to newest week: ${chart.map((week) => `${weekLabel(week.weekStart)} ${week.applications}`).join(', ')}`}>
          {chart.map((week, index) => <div key={week.weekStart} className={index === chart.length - 1 ? 'is-current' : undefined}>
            <strong>{week.applications}</strong><i style={{ height: `${(week.applications / max) * 8}rem` }} /><span>{weekLabel(week.weekStart)}</span></div>)}
        </div>
        <div className="ck-weeks">
          {weeks.map((week) => <div key={week.weekStart}>
            <strong>Week of {weekLabel(week.weekStart)}</strong>
            <ul><li>{week.applications} confirmed applications</li><li>{week.replies} replies</li>
              <li>{week.interviews} interviews</li><li>{week.offers} offers</li></ul>
            {week.reviewedAt ? <strong className="t-ok">Reviewed</strong>
              : <button className="ck-btn ck-btn--small" disabled={busy} onClick={() => void run('review.complete', [String(week.weekStart).slice(0, 10)])}>Mark reviewed</button>}
          </div>)}
        </div>
      </div>
      <div className="ck-stack">
        <div className="ck-card">
          <h2>From lead to receipt</h2>
          {funnel.map(([label, n]) => <div key={label} style={{ display: 'grid', gap: '.25rem' }}>
            <div className="ck-row" style={{ justifyContent: 'space-between', fontSize: '1rem' }}><span className="ck-muted">{label}</span><strong>{n}</strong></div>
            <div className={`ck-meter${label === 'Confirmed receipts' ? '' : ' ck-meter--muted'}`}><span style={{ width: `${(n / top) * 100}%` }} /></div>
          </div>)}
        </div>
        <div className="ck-card ck-card--dashed">
          <h2>User-reported history</h2>
          <span className="ck-muted" style={{ fontSize: '1rem' }}>Not counted in weekly totals.</span>
          <div className="ck-divided">
            {!data.reports.length && <span className="ck-muted">No reports.</span>}
            {data.reports.map((report: any) => <div key={report.id} style={{ display: 'grid', fontSize: '1rem' }}>
              <strong>{report.organization} {report.external_job_id}</strong>
              <span className="ck-muted">{report.state === 'referral_expected' ? 'Referral expected; unconfirmed' : 'Submitted, reported by you'}</span>
              {report.source_note && <small className="ck-faint">{report.source_note}</small>}
            </div>)}
          </div>
        </div>
        <form className="ck-card" onSubmit={(event) => { event.preventDefault(); const f = event.currentTarget;
          void run('review.event', [{ leadId: field(f, 'lead'), type: field(f, 'type'), date: field(f, 'date'), note: field(f, 'note') }]); }}>
          <h2>Record follow-up activity</h2>
          <label>Lead<select name="lead" required>{data.leads.map((lead: any) => <option key={lead.id} value={lead.id}>{lead.title}</option>)}</select></label>
          <div className="jobsFormGrid">
            <label>Activity<select name="type">{['kept', 'reply', 'interview', 'offer'].map((type) => <option key={type}>{type}</option>)}</select></label>
            <label>Date<input type="date" name="date" required /></label>
          </div>
          <label>Evidence note<input name="note" maxLength={1000} /></label>
          <button className="ck-btn" style={{ alignSelf: 'flex-start' }} disabled={busy}>Save activity</button>
        </form>
      </div>
    </section>
  </>;
}
