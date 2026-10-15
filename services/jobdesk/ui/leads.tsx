import { useState } from 'react';
import { decisionLabel, PageHead, recommendationLabel, Status, STAGES, verificationLabel, type Pipeline, type Run } from './common';

const filters = [['all', 'All'], ['review', 'Review'], ['keep', 'Pursue'], ['pass', 'Pass']] as const;
type Filter = (typeof filters)[number][0];
const field = (form: HTMLFormElement, name: string) => String(new FormData(form).get(name) ?? '').trim();

/** Full lead update: the owner replaces every field, so pass the current values through. */
export const leadUpdate = (lead: any, patch: Record<string, unknown>) => ({
  id: lead.id, decision: lead.decision, verification: lead.verificationStatus,
  ...(lead.applicationStage ? { stage: lead.applicationStage } : {}),
  nextAction: lead.nextAction ?? '', ...(lead.nextActionDate ? { nextActionDate: String(lead.nextActionDate).slice(0, 10) } : {}),
  notes: lead.notes ?? '', ...patch,
});

export function Leads({ leads, pipeline, run, busy }: { leads: any[]; pipeline: Pipeline; run: Run; busy: boolean }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(!leads.length);
  const byId = new Map(pipeline.jobs.map((job) => [job.id, job]));
  const eligible = (lead: any) => lead.decision === 'keep' && lead.applicationStage !== 'applied' && !byId.get(lead.id)?.itemId;
  const shown = leads.filter((lead) => filter === 'all' || lead.decision === filter);
  const count = (f: Filter) => f === 'all' ? leads.length : leads.filter((lead) => lead.decision === f).length;
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <>
    <PageHead title="Leads" description="Imported leads stay unverified until you review the original posting.">
      <button type="button" className="ck-btn ck-btn--primary" aria-expanded={adding} aria-controls="add-lead" onClick={() => setAdding(!adding)}>Add a lead</button>
    </PageHead>
    {adding && <form id="add-lead" className="ck-card" onSubmit={(event) => {
      event.preventDefault(); const f = event.currentTarget;
      void run('leads.add', [{ url: field(f, 'url'), title: field(f, 'title'), organization: field(f, 'organization'), location: field(f, 'location'), notes: field(f, 'notes') }]);
    }}>
      <h2>Add a lead</h2>
      <div className="jobsFormGrid">
        <label>Posting URL<input type="url" name="url" required maxLength={2000} /></label>
        <label>Role title<input name="title" required maxLength={250} /></label>
        <label>Organization<input name="organization" maxLength={200} /></label>
        <label>Location<input name="location" maxLength={160} /></label>
      </div>
      <label>Notes<textarea name="notes" maxLength={4000} /></label>
      <div className="ck-row"><button className="ck-btn ck-btn--primary" disabled={busy}>Save lead</button>
        <button type="button" className="ck-btn ck-btn--ghost" onClick={() => setAdding(false)}>Cancel</button></div>
    </form>}
    <div className="ck-chips" role="group" aria-label="Filter by your decision">
      {filters.map(([id, label]) => <button key={id} type="button" className="ck-chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
        {label} <span aria-label={`${count(id)} leads`}>{count(id)}</span></button>)}
      <a className="ck-chip ck-chip--dashed" href="/jobs/excluded">Excluded</a>
    </div>
    <section className="ck-card ck-card--flush ck-scroll" aria-label="Leads">
      {!shown.length ? <p className="ck-empty" style={{ margin: '1rem' }}>No leads here yet.</p> : <table className="ck-table">
        <thead><tr><th scope="col"><span className="sr-only">Select for a batch</span></th><th scope="col">Role</th><th scope="col">Posting</th>
          <th scope="col">Assistant says</th><th scope="col">Your decision</th><th scope="col">Stage</th></tr></thead>
        <tbody>{shown.map((lead) => {
          const job = byId.get(lead.id), on = selected.has(lead.id), canQueue = eligible(lead);
          const rec = recommendationLabel(job?.recommendation);
          return <tr key={lead.id} data-selected={on}>
            <td><input type="checkbox" className="ck-check" checked={on} disabled={!canQueue} onChange={() => toggle(lead.id)}
              aria-label={`${lead.title} · ${lead.organization || 'Employer unknown'}`}
              title={canQueue ? 'Select for a pursued batch' : 'Choose Pursue to queue this role'} /></td>
            <td><a href={`/jobs/${lead.id}`}>{lead.title}</a>
              <span className="ck-sub">{[lead.organization, lead.location, lead.source].filter(Boolean).join(' · ')}</span></td>
            <td><Status {...verificationLabel(lead.verificationStatus)} /></td>
            <td><strong className={rec.tone}>{rec.label}</strong></td>
            <td><select aria-label={`Decision for ${lead.title}`} value={lead.decision} disabled={busy}
              onChange={(event) => void run('leads.update', [leadUpdate(lead, { decision: event.target.value })])}>
              {Object.entries(decisionLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></td>
            <td><span className="ck-badge">{job ? STAGES[job.stage] : lead.decision === 'pass' ? 'Passed' : 'Discovered'}</span></td>
          </tr>;
        })}</tbody>
      </table>}
    </section>
    {selected.size > 0 && <div className="ck-actionbar" role="region" aria-label="Selected leads">
      <strong>{selected.size} lead{selected.size === 1 ? '' : 's'} selected</strong>
      <div className="ck-row">
        <button type="button" className="ck-btn ck-btn--ghost" onClick={() => setSelected(new Set())}>Clear</button>
        <button type="button" className="ck-btn ck-btn--primary" disabled={busy} onClick={() => void run('batches.create', [[...selected]], '/jobs')}>Queue as a pursued batch</button>
      </div>
    </div>}
  </>;
}
