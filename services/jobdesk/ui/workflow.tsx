import { useState } from 'react';
import type { Method } from '../contract';

type Run = (method: Method, args?: unknown[], reload?: boolean) => Promise<void>;
const labels: Record<string, string> = { current: 'Current', stale: 'Stale', partial: 'Partial', failed: 'Failed', passed: 'Passed', complete: 'Complete', pending: 'Pending', needs_attention: 'Needs attention', running: 'Running' };
export function WorkflowOverview({ data, run, busy, excluded = false }: { data: any; run: Run; busy: boolean; excluded?: boolean }) {
  const [urls, setUrls] = useState('');
  const settings = data.workflow.settings;
  return <>
    <header className="jobsPageHeader"><h1>{excluded ? 'Excluded jobs' : 'Discovery and preparation'}</h1>
      <p>{excluded ? 'Automatic exclusions retain their evidence. Restore a job without changing your keep or pass decision.' : 'Collect evidence, review candidates with your assistant, then assemble approved experience.'}</p></header>
    {excluded ? <section aria-label="Recoverable exclusions" className="workflowCards">
      {!data.exclusions.length && <p>No automatic exclusions have been saved.</p>}
      {data.exclusions.map((item: any) => <article className="jobsPanel" key={item.id}>
        <h2><a href={`/jobs/${item.lead_id}`}>{item.title}</a></h2>
        <p>{item.organization} · {item.restored_at ? 'Restored' : item.current ? 'Excluded' : 'Stale exclusion'}</p>
        <p><strong>Reason:</strong> {item.rule}</p><p>{item.evidence}</p>
        <p>Your decision: {item.decision}</p>
        {!item.restored_at && <button disabled={busy} onClick={() => void run('exclusions.restore', [item.id])}>Restore this job</button>}
      </article>)}
      {data.exclusionPage.nextOffset !== null && <a href={`/jobs/excluded?offset=${data.exclusionPage.nextOffset}`}>Next page of exclusions</a>}
      {new URLSearchParams(location.search).has('offset') && <a href="/jobs/excluded">First page of exclusions</a>}
    </section> : <>
      <section className="jobsPanel"><h2>Collect jobs</h2>
        <p>Built In Chicago is a bounded pilot: the first listing page and up to 25 job details. It does not cover the whole site. Existing feeds remain available.</p>
        <div className="workflowActions"><button disabled={busy} onClick={() => void run('collection.run', [{ source: 'builtin' }])}>Collect Built In first page</button>
          <button disabled={busy} onClick={() => void run('collection.run', [{ source: 'feeds' }])}>Collect enabled feeds</button></div>
        <form onSubmit={(event) => { event.preventDefault(); void run('collection.run', [{ source: 'builtin', urls: urls.split(/\s+/).filter(Boolean) }]); }}>
          <label>Specific Built In Chicago job URLs<textarea rows={3} value={urls} onChange={(event) => setUrls(event.target.value)} /></label>
          <button disabled={busy || !urls.trim()}>Collect these URLs</button>
        </form>
      </section>
      <section className="jobsPanel"><h2>Collection health</h2>
        {!data.runs.length && <p>No collection has run yet.</p>}
        {data.runs.map((item: any) => <article className="workflowRun" key={item.id}>
          <h3>{item.source === 'builtin' ? 'Built In Chicago' : 'Google Alert feeds'} — {labels[item.state]}</h3><p>{item.coverage}</p>
          <p>Requested: {item.counts.requested} · Fetched: {item.counts.fetched} · Parsed: {item.counts.parsed} · Failed: {item.counts.failed} · Saved: {item.counts.saved}</p>
          {item.errors.length > 0 && <details><summary>Read collection errors</summary><ul>{item.errors.map((error: string, i: number) => <li key={i}>{error}</li>)}</ul></details>}
          {item.resumable && item.state !== 'running' && <button disabled={busy} onClick={() => void run('collection.run', [{ source: item.source, runId: item.id }])}>Resume failed targets</button>}
        </article>)}
      </section>
      <section className="jobsPanel"><h2>Review candidates</h2>
        <p>Ask your assistant to review the collected jobs. It saves reasons and uncertainties. You choose which job to prepare.</p>
        <p><a href="/jobs/excluded">Review recoverable exclusions</a></p>
        <ul>{data.jobs.jobs.map((job: any) => <li key={job.id}><a href={`/jobs/${job.id}`}>{job.title}</a> — {job.organization || 'Employer unknown'} · {job.verificationStatus}</li>)}</ul>
        {data.jobs.nextOffset !== null && <p>More jobs are available through your assistant or the Leads view.</p>}
      </section>
      <section className="jobsPanel"><h2>Search criteria and résumé links</h2>
        <form onSubmit={(event) => {
          event.preventDefault(); const form = new FormData(event.currentTarget);
          const lines = (key: string) => String(form.get(key) ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
          const links = lines('links').map((line) => { const at = line.indexOf(' | '); return { label: line.slice(0, at), url: line.slice(at + 3) }; });
          void run('workflow.configure', [{ preferences: String(form.get('preferences') ?? ''),
            minimumAnnualSalary: form.get('salary') ? Number(form.get('salary')) : undefined, currency: String(form.get('currency')),
            excludedEmployers: lines('employers'), excludedLocations: lines('locations'), links }]);
        }}>
          <label>Role preferences<textarea name="preferences" maxLength={5000} rows={4} defaultValue={settings.preferences} /></label>
          <label>Minimum annual salary, if required<input name="salary" type="number" min={0} defaultValue={settings.minimumAnnualSalary} /></label>
          <label>Salary currency<input name="currency" pattern="[A-Z]{3}" maxLength={3} defaultValue={settings.currency} /></label>
          <p>Salary exclusion uses a known published annual maximum in this currency. Missing salary stays unknown.</p>
          <label>Excluded employers, one exact name per line<textarea name="employers" rows={3} defaultValue={settings.excludedEmployers.join('\n')} /></label>
          <label>Excluded locations, one exact location per line<textarea name="locations" rows={3} defaultValue={settings.excludedLocations.join('\n')} /></label>
          <label>Résumé links, one per line: Label | https://address<textarea name="links" rows={3} defaultValue={settings.links.map((link: any) => `${link.label} | ${link.url}`).join('\n')} /></label>
          <button disabled={busy}>Save criteria and links</button>
        </form>
      </section>
    </>}
  </>;
}

export function WorkflowMaterials({ leadId, data, run, busy }: { leadId: string; data: any; run: Run; busy: boolean }) {
  return <section className="jobsPanel"><h2>Prepared materials</h2>
    <p>Ask your assistant to assess this job and select approved claim IDs. The harness assembles the documents without rewriting your experience.</p>
    {data.stages.slice(0, 4).map((stage: any) => <p key={stage.id}>{stage.stage === 'assessment' ? 'Search assessment' : 'Claim selection'}: <strong>{labels[stage.state]}</strong>{stage.error && ` — ${stage.error}`}</p>)}
    <button disabled={busy} onClick={() => void run('workflow.build', [{ leadId }])}>Build saved claim selection</button>
    {data.materials.slice(0, 3).map((material: any) => <article className="workflowRun" key={material.id}>
      <h3>{labels[material.state]} materials</h3>
      <p>Content: {labels[material.validation.content] || 'Pending'} · Page bounds: {labels[material.validation.bounds] || 'Pending'} · Rendered review: {labels[material.validation.visual] || 'Pending'}</p>
      {material.error && <p role="status">{material.error}</p>}
      <ul>{material.artifacts.map((artifact: any) => <li key={artifact.id}><a href={artifact.url}>{artifact.kind === 'resume' ? 'Employer résumé' : artifact.kind === 'outreach' ? 'Outreach draft' : 'Private review packet'}</a></li>)}</ul>
      {material.state === 'current' && material.validation.visual !== 'passed' && <form onSubmit={(event) => { event.preventDefault();
        void run('workflow.review', [{ id: material.id, inputHash: material.input_hash, passed: true, note: 'User inspected every rendered page, text, spacing, and links in the exported documents.' }]); }}>
        <label className="workflowCheck"><input type="checkbox" required />I opened every exported page and checked the text, links, spacing, and clipping.</label>
        <button disabled={busy}>Record rendered review</button>
      </form>}
      {material.state === 'needs_attention' && material.attempts < 2 && <button disabled={busy} onClick={() => void run('workflow.build', [{ leadId, repair: true }])}>Try one targeted rebuild</button>}
    </article>)}
    <p>Rendered review does not approve an employer submission.</p>
  </section>;
}
