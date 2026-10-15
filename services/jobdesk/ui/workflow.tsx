import { useState } from 'react';
import { PageHead, recommendationLabel, verificationLabel, Status, type Pipeline, type Run } from './common';

const labels: Record<string, string> = { current: 'Current', stale: 'Stale', partial: 'Partial', failed: 'Failed', passed: 'Passed', complete: 'Complete', pending: 'Pending', needs_attention: 'Needs attention', running: 'Running' };
const stateTone: Record<string, string> = { complete: 't-ok', partial: 't-warn', failed: 't-bad', running: 't-accent' };
const countNames = [['requested', 'Requested'], ['fetched', 'Fetched'], ['parsed', 'Parsed'], ['failed', 'Failed'], ['saved', 'Saved']] as const;

function Excluded({ data, run, busy }: { data: any; run: Run; busy: boolean }) {
  return <>
    <PageHead title="Excluded jobs" description="Automatic exclusions retain their evidence. Restore a job without changing your keep or pass decision." />
    <section aria-label="Recoverable exclusions" className="ck-grid">
      {!data.exclusions.length && <p className="ck-empty">No automatic exclusions have been saved.</p>}
      {data.exclusions.map((item: any) => <article className="ck-card" key={item.id}>
        <h2><a href={`/jobs/${item.lead_id}`}>{item.title}</a></h2>
        <p style={{ margin: 0 }}>{item.organization} · {item.restored_at ? 'Restored' : item.current ? 'Excluded' : 'Stale exclusion'}</p>
        <p style={{ margin: 0 }}><strong>Reason:</strong> {item.rule}</p><p className="ck-muted" style={{ margin: 0 }}>{item.evidence}</p>
        <p style={{ margin: 0 }}>Your decision: {item.decision}</p>
        {!item.restored_at && <button className="ck-btn" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void run('exclusions.restore', [item.id])}>Restore this job</button>}
      </article>)}
    </section>
    <div className="ck-row">
      {data.exclusionPage.nextOffset !== null && <a className="ck-btn" href={`/jobs/excluded?offset=${data.exclusionPage.nextOffset}`}>Next page of exclusions</a>}
      {new URLSearchParams(location.search).has('offset') && <a className="ck-btn" href="/jobs/excluded">First page of exclusions</a>}
    </div>
  </>;
}

export function WorkflowOverview({ data, run, busy, excluded = false }: { data: any; run: Run; busy: boolean; excluded?: boolean }) {
  const [urls, setUrls] = useState('');
  if (excluded) return <Excluded data={data} run={run} busy={busy} />;
  const settings = data.workflow.settings;
  const recs = new Map(((data.pipeline as Pipeline | undefined)?.jobs ?? []).map((job) => [job.id, job.recommendation]));
  const excludedCount = data.exclusionPage?.exclusions?.filter((item: any) => !item.restored_at && item.current).length ?? 0;
  return <>
    <PageHead title="Discovery and preparation" description="Collect evidence, review candidates with your assistant, then assemble approved experience.">
      <button className="ck-btn" disabled={busy} onClick={() => void run('collection.run', [{ source: 'feeds' }])}>Collect enabled feeds</button>
      <button className="ck-btn ck-btn--primary" disabled={busy} onClick={() => void run('collection.run', [{ source: 'builtin' }])}>Collect Built In first page</button>
    </PageHead>
    <p className="ck-muted" style={{ margin: 0 }}>Built In Chicago is a bounded pilot: the first listing page and up to 25 job details. It does not cover the whole site. Existing feeds remain available.</p>
    <section className="ck-grid" aria-label="Collection health">
      {!data.runs.length && <p className="ck-empty">No collection has run yet.</p>}
      {data.runs.map((item: any) => {
        const counts = item.counts, total = Math.max(1, counts.parsed + counts.failed);
        return <article className="ck-card" key={item.id}>
          <h2 className="ck-card-head">{item.source === 'builtin' ? 'Built In Chicago' : 'Google Alert feeds'}<span className="sr-only"> — </span>
            <span className={stateTone[item.state] ?? 't-muted'} style={{ fontSize: '1rem' }}>{labels[item.state]}</span></h2>
          <p className="ck-muted" style={{ margin: 0, fontSize: '1rem' }}>{item.coverage}</p>
          <div className="ck-segbar" aria-hidden="true">
            {counts.parsed > 0 && <span style={{ flex: counts.parsed / total, background: 'var(--ok)' }} />}
            {counts.failed > 0 && <span style={{ flex: counts.failed / total, background: 'var(--bad)' }} />}
          </div>
          <dl className="ck-counts">{countNames.map(([key, label]) => <div key={key}><dt>{label}</dt>
            <dd className={key === 'failed' && counts[key] ? 't-bad' : key === 'saved' ? 't-ok' : undefined}>{counts[key]}</dd></div>)}</dl>
          {item.errors.length > 0 && <details><summary>Read collection errors</summary><ul>{item.errors.map((error: string, i: number) => <li key={i}>{error}</li>)}</ul></details>}
          {item.resumable && item.state !== 'running' && <button className="ck-btn" style={{ alignSelf: 'flex-start' }} disabled={busy}
            onClick={() => void run('collection.run', [{ source: item.source, runId: item.id }])}>Resume failed targets</button>}
        </article>;
      })}
    </section>
    <section className="ck-card ck-card--flush" aria-labelledby="candidates-title">
      <div className="ck-card-head"><h2 id="candidates-title">Candidates reviewed by your assistant</h2>
        <span className="ck-muted" style={{ fontSize: '1rem' }}>{excludedCount ? `${excludedCount} excluded automatically · ` : ''}<a href="/jobs/excluded">Review recoverable exclusions</a></span></div>
      <p className="ck-muted" style={{ margin: 0, padding: '1rem 1.25rem 0' }}>Ask your assistant to review the collected jobs. It saves reasons and uncertainties. You choose which job to prepare.</p>
      <div className="ck-scroll">
        {!data.jobs.jobs.length ? <p className="ck-empty" style={{ margin: '1rem' }}>No collected jobs yet.</p> : <table className="ck-table">
          <thead><tr><th scope="col">Role</th><th scope="col">Assistant says</th><th scope="col">Posting</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
          <tbody>{data.jobs.jobs.map((job: any) => {
            const rec = recommendationLabel(recs.get(job.id));
            return <tr key={job.id}>
              <td><a href={`/jobs/${job.id}`}>{job.title}</a><span className="ck-sub">{job.organization || 'Employer unknown'}{job.possibleDuplicateIds?.length ? ' · possible duplicate' : ''}</span></td>
              <td><strong className={rec.tone}>{rec.label}</strong>{job.assessment !== 'current' && recs.get(job.id) ? <span className="ck-sub">Assessment is stale</span> : null}</td>
              <td><Status {...verificationLabel(job.verificationStatus)} /></td>
              <td><a className="ck-btn ck-btn--small" href={`/jobs/${job.id}`} aria-label={`Open ${job.title}`}>Open</a></td>
            </tr>;
          })}</tbody>
        </table>}
      </div>
      {data.jobs.nextOffset !== null && <p className="ck-muted" style={{ margin: 0, padding: '1rem 1.25rem' }}>More jobs are available through your assistant or the Leads view.</p>}
    </section>
    <section className="ck-grid">
      <form className="ck-card" onSubmit={(event) => { event.preventDefault(); void run('collection.run', [{ source: 'builtin', urls: urls.split(/\s+/).filter(Boolean) }]); }}>
        <h2>Collect specific jobs</h2>
        <label>Specific Built In Chicago job URLs<textarea rows={3} value={urls} onChange={(event) => setUrls(event.target.value)} /></label>
        <button className="ck-btn" style={{ alignSelf: 'flex-start' }} disabled={busy || !urls.trim()}>Collect these URLs</button>
      </form>
      <form className="ck-card" onSubmit={(event) => {
        event.preventDefault(); const form = new FormData(event.currentTarget);
        const lines = (key: string) => String(form.get(key) ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
        const links = lines('links').map((line) => { const at = line.indexOf(' | '); return { label: line.slice(0, at), url: line.slice(at + 3) }; });
        void run('workflow.configure', [{ preferences: String(form.get('preferences') ?? ''),
          minimumAnnualSalary: form.get('salary') ? Number(form.get('salary')) : undefined, currency: String(form.get('currency')),
          excludedEmployers: lines('employers'), excludedLocations: lines('locations'), links }]);
      }}>
        <h2>Search criteria and résumé links</h2>
        <details>
          <summary>Edit criteria</summary>
          <label>Role preferences<textarea name="preferences" maxLength={5000} rows={4} defaultValue={settings.preferences} /></label>
          <label>Minimum annual salary, if required<input name="salary" type="number" min={0} defaultValue={settings.minimumAnnualSalary} /></label>
          <label>Salary currency<input name="currency" pattern="[A-Z]{3}" maxLength={3} defaultValue={settings.currency} /></label>
          <p>Salary exclusion uses a known published annual maximum in this currency. Missing salary stays unknown.</p>
          <label>Excluded employers, one exact name per line<textarea name="employers" rows={3} defaultValue={settings.excludedEmployers.join('\n')} /></label>
          <label>Excluded locations, one exact location per line<textarea name="locations" rows={3} defaultValue={settings.excludedLocations.join('\n')} /></label>
          <label>Résumé links, one per line: Label | https://address<textarea name="links" rows={3} defaultValue={settings.links.map((link: any) => `${link.label} | ${link.url}`).join('\n')} /></label>
          <button className="ck-btn">Save criteria and links</button>
        </details>
      </form>
    </section>
  </>;
}
