import { useState } from 'react';
import { PageHead, type Run } from './common';
import type { Method } from '../contract';

type SearchRow = { key: string; id?: string; lane: string; location: string; query: string; feedUrl: string; enabled: boolean };
const toRows = (queries: any[]): SearchRow[] => queries.map((query) => ({ key: String(query.id), id: String(query.id), lane: String(query.lane),
  location: String(query.location ?? ''), query: String(query.query), feedUrl: String(query.feedUrl ?? ''), enabled: Boolean(query.enabled) }));
const toSaved = (rows: SearchRow[]) => rows.map(({ key: _key, id, ...row }) => (id ? { id, ...row } : row));
const field = (form: HTMLFormElement, name: string) => String(new FormData(form).get(name) ?? '').trim();

function SearchEditor({ queries, busy, onSave }: { queries: any[]; busy: boolean; onSave: (rows: ReturnType<typeof toSaved>) => void }) {
  const [rows, setRows] = useState<SearchRow[]>(() => toRows(queries));
  const update = (key: string, patch: Partial<SearchRow>) => setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
  return <form onSubmit={(event) => { event.preventDefault(); onSave(toSaved(rows)); }} className="ck-stack" style={{ marginTop: '.75rem' }}>
    <p style={{ margin: 0 }}>Create a Google Alert for each search (for example <q>remote data analyst jobs</q>), choose <q>Deliver to: RSS feed</q>,
      and paste its feed address here. Leave the address empty to keep a search as a note.</p>
    {!rows.length && <p style={{ margin: 0 }}>No searches yet. Add one for each kind of role and place you are looking for.</p>}
    {rows.map((row, index) => <fieldset key={row.key}>
      <legend>Search {index + 1}</legend>
      <div className="jobsFormGrid">
        <label>Role or field<input required maxLength={120} value={row.lane} onChange={(event) => update(row.key, { lane: event.target.value })} /></label>
        <label>Location<input maxLength={120} placeholder="Remote, a city, or leave blank" value={row.location} onChange={(event) => update(row.key, { location: event.target.value })} /></label>
      </div>
      <label>Search words<textarea required minLength={8} maxLength={500} value={row.query} onChange={(event) => update(row.key, { query: event.target.value })} /></label>
      <label>Google Alert RSS feed address<input type="url" value={row.feedUrl} onChange={(event) => update(row.key, { feedUrl: event.target.value })} /></label>
      <label className="ck-confirm"><input type="checkbox" className="ck-check" checked={row.enabled} onChange={(event) => update(row.key, { enabled: event.target.checked })} />Include in scans</label>
      <button type="button" className="ck-btn ck-btn--small" onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}>Remove search {index + 1}</button>
    </fieldset>)}
    <div className="ck-row">
      <button type="button" className="ck-btn" disabled={rows.length >= 20}
        onClick={() => setRows((current) => [...current, { key: crypto.randomUUID(), lane: '', location: '', query: '', feedUrl: '', enabled: true }])}>Add a search</button>
      <button className="ck-btn ck-btn--primary" disabled={busy}>Save searches</button>
    </div>
  </form>;
}

export function Settings({ data, run, rpc, busy, setBusy, setError }: { data: any; run: Run; rpc: (method: Method, args?: unknown[]) => Promise<any>;
  busy: boolean; setBusy: (busy: boolean) => void; setError: (error: string) => void }) {
  const queries: any[] = data.search.queries;
  const [provider, setProvider] = useState<'none' | 'anthropic' | 'openai'>(data.settings.drafting.provider);
  const usage = data.search.status.usage;
  const toggle = (index: number) => {
    const rows = toRows(queries);
    rows[index] = { ...rows[index], enabled: !rows[index].enabled };
    void run('search.save', [toSaved(rows)]);
  };
  return <>
    <PageHead title="Settings" description="Searches, time zone and backups. Scans run only when you ask, while this computer is awake." />
    <section className="ck-grid">
      <div className="ck-card ck-card--flush">
        <div className="ck-card-head" style={{ borderBottom: 0 }}><h2>Your job searches</h2><span className="ck-muted" style={{ fontSize: '1rem' }}>{queries.length} of 20</span></div>
        {queries.map((query, index) => <div className="ck-search" key={query.id}>
          <div style={{ display: 'grid', gap: '.2rem', minWidth: 0 }}>
            <strong>{query.lane}{query.location ? ` · ${query.location}` : ''}</strong>
            <p className="ck-muted">“{query.query}”</p>
            <p className={query.feedUrl ? (query.enabled ? 't-ok' : 't-muted') : 't-muted'} style={{ fontWeight: 700 }}>
              {query.feedUrl ? (query.enabled ? 'Feed active' : 'Feed paused') : 'No feed address · kept as a note'}</p>
          </div>
          <input type="checkbox" role="switch" className="ck-switch" checked={Boolean(query.enabled)} disabled={busy}
            aria-label={`Include ${query.lane} in scans`} onChange={() => toggle(index)} />
        </div>)}
        <details style={{ padding: '1rem 1.25rem', borderTop: '1px solid var(--border)' }} open={!queries.length}>
          <summary>{queries.length ? 'Edit or add searches' : 'Add a search'}</summary>
          <SearchEditor queries={queries} busy={busy} onSave={(rows) => void run('search.save', [rows])} />
        </details>
      </div>
      <div className="ck-stack">
        <div className="ck-card">
          <h2>Feed status</h2>
          <div className="ck-meter"><span style={{ width: `${Math.min(100, (usage.callsUsed / Math.max(1, usage.callCap)) * 100)}%` }} /></div>
          <span className="ck-muted" style={{ fontSize: '1rem' }}>{usage.callsUsed} of {usage.callCap} monthly polls used. One successful scan per UTC day; failed scans may be retried.</span>
          <button className="ck-btn ck-btn--primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void run('search.run', [], false)}>Scan feeds now</button>
        </div>
        <form className="ck-card" onSubmit={(event) => {
          event.preventDefault(); const f = event.currentTarget; const key = field(f, 'apiKey');
          setBusy(true); setError('');
          void (async () => {
            try {
              if (provider !== 'none' && key) await rpc('settings.saveApiKey', [provider, key]);
              await rpc('settings.save', [{ timeZone: data.settings.timeZone, drafting: { provider, model: provider === 'none' ? data.settings.drafting.model : field(f, 'model') } }]);
              location.reload();
            } catch (cause) { setError(cause instanceof Error ? cause.message : 'Action failed.'); setBusy(false); }
          })();
        }}>
          <h2>Drafting in this app (optional)</h2>
          <span className="ck-muted" style={{ fontSize: '1rem' }}>You do not need this. Claude or ChatGPT can prepare drafts for you from your approved claims. Turn it on only if you
            want the <q>Assess and prepare draft</q> button here; it uses your own API key and stops at the monthly budget.</span>
          <div className="ck-segmented" role="group" aria-label="Provider" style={{ borderRadius: 'var(--r-btn)' }}>
            {([['none', 'Off'], ['anthropic', 'Anthropic (Claude)'], ['openai', 'OpenAI']] as const).map(([id, label]) =>
              <button key={id} type="button" aria-pressed={provider === id} onClick={() => setProvider(id)}>{label}</button>)}
          </div>
          {provider !== 'none' && <>
            <label>Model<input name="model" maxLength={100} placeholder="Leave blank for the provider's default" defaultValue={data.settings.drafting.model} /></label>
            <label>API key<input name="apiKey" type="password" autoComplete="off" maxLength={500}
              placeholder={data.settings.apiKeys?.[provider] ? 'Saved. Enter a new key to replace it.' : 'Paste your key'} /></label>
          </>}
          <span className="ck-muted" style={{ fontSize: '1rem' }}>Keys stay in a private file on this computer, outside the database and its backups. Saved keys:{' '}
            {data.settings.apiKeys?.anthropic ? 'Anthropic ✓' : 'Anthropic none'} · {data.settings.apiKeys?.openai ? 'OpenAI ✓' : 'OpenAI none'}</span>
          <button className="ck-btn" style={{ alignSelf: 'flex-start' }} disabled={busy}>Save drafting settings</button>
        </form>
        <div className="ck-card">
          <h2>Your AI assistant</h2>
          <span className="ck-muted" style={{ fontSize: '1rem' }}>Connect Claude Desktop or the ChatGPT desktop app, change your preferences or add your résumé with the setup guide.</span>
          <a className="ck-btn" style={{ alignSelf: 'flex-start' }} href="/jobs/welcome">Open the setup guide</a>
        </div>
        <div className="ck-card">
          <div className="ck-card-head"><h2>Local backup</h2>
            <button className="ck-btn" disabled={busy} onClick={() => void run('backup', [], false)}>Back up now</button></div>
          <span className="ck-muted" style={{ fontSize: '1rem' }}>Backups stay in the private local data directory.</span>
        </div>
        <form className="ck-card" onSubmit={(event) => { event.preventDefault(); void run('settings.save', [{ timeZone: field(event.currentTarget, 'timeZone'), drafting: data.settings.drafting }]); }}>
          <h2>Time zone</h2>
          <span className="ck-muted" style={{ fontSize: '1rem' }}>Weekly reviews and application dates use this zone.</span>
          <label>Time zone<input name="timeZone" list="timeZones" required defaultValue={data.settings.timeZone} /></label>
          <datalist id="timeZones">{Intl.supportedValuesOf('timeZone').map((zone) => <option key={zone} value={zone} />)}</datalist>
          <button className="ck-btn" style={{ alignSelf: 'flex-start' }} disabled={busy}>Save time zone</button>
        </form>
      </div>
    </section>
  </>;
}
