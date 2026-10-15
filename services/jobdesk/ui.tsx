/* Standalone loopback UI uses ordinary document navigation. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import TruthEditor from './ui/truth-editor';
import JobsShell from './ui/jobs-shell';
import { WorkflowOverview, WorkflowMaterials } from './ui/workflow';
import type { ReviewClaim } from '../../lib/resume-truth-review';
import type { SqlRow } from '../../lib/job-storage';
import type { Method } from './contract';

let csrf = '';
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const target = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    location.href,
  );
  const method = init.method ?? (input instanceof Request ? input.method : 'GET');
  const headers = new Headers(
    init.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (target.origin === location.origin && method !== 'GET') headers.set('X-Jobdesk-CSRF', csrf);
  return nativeFetch(input, { ...init, headers, cache: 'no-store' });
};
async function rpc(method: Method, args: unknown[] = []): Promise<any> {
  const response = await fetch('/api/jobdesk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Unable to complete this action.');
  return result.data;
}
const value = (form: HTMLFormElement, name: string) =>
  String(new FormData(form).get(name) ?? '').trim();
const heading = (title: string, description: string) => (
  <header className="jobsPageHeader">
    <h1>{title}</h1>
    <p>{description}</p>
  </header>
);

const today = () => new Date().toISOString().slice(0, 10);

function PasteClaims({ busy, onSubmit, heading: title = 'Paste résumé text' }: { busy: boolean; heading?: string; onSubmit: (text: string, note: string) => void }) {
  return (
    <form
      className="jobsPanel"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value(event.currentTarget, 'text'), value(event.currentTarget, 'note'));
      }}
    >
      <h2>{title}</h2>
      <p>Each line becomes one claim to review. Bullets are removed and lines you already have are skipped.</p>
      <label>
        Résumé text
        <textarea name="text" rows={10} required maxLength={100000} />
      </label>
      <label>
        Where this came from
        <input name="note" required minLength={8} maxLength={1000} defaultValue={`Pasted into the cockpit on ${today()}`} />
      </label>
      <button disabled={busy}>Add as claims to review</button>
    </form>
  );
}

function ResumeOnboarding({ busy, onPaste }: { busy: boolean; onPaste: (text: string, note: string) => void }) {
  return (
    <>
      {heading('Add your résumé', 'Your résumé becomes a bank of claims. Nothing is used in an application until you review it.')}
      <section className="jobsPanel">
        <h2>Easiest: ask your AI assistant</h2>
        <p>
          In Claude or ChatGPT, attach your résumé and say: <q>Import my résumé into Job Search Harness.</q> It copies your
          wording into this list, grouped by role, and then you review each claim here.
        </p>
      </section>
      <PasteClaims busy={busy} onSubmit={onPaste} heading="Or paste it yourself" />
    </>
  );
}

type SearchRow = { key: string; id?: string; lane: string; location: string; query: string; feedUrl: string; enabled: boolean };
function SearchEditor({ queries, busy, onSave }: { queries: SqlRow[]; busy: boolean; onSave: (rows: Omit<SearchRow, 'key'>[]) => void }) {
  const [rows, setRows] = useState<SearchRow[]>(() =>
    queries.map((query) => ({ key: String(query.id), id: String(query.id), lane: String(query.lane), location: String(query.location ?? ''),
      query: String(query.query), feedUrl: String(query.feedUrl ?? ''), enabled: Boolean(query.enabled) })));
  const update = (key: string, patch: Partial<SearchRow>) => setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
  return (
    <form
      className="jobsPanel"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(rows.map(({ key: _key, id, ...row }) => (id ? { id, ...row } : row)));
      }}
    >
      <h2>Your job searches</h2>
      <p>
        Create a Google Alert for each search (for example <q>remote data analyst jobs</q>), choose <q>Deliver to: RSS feed</q>,
        and paste its feed address here. Leave the address empty to keep a search as a note.
      </p>
      {!rows.length && <p>No searches yet. Add one for each kind of role and place you are looking for.</p>}
      {rows.map((row, index) => (
        <fieldset key={row.key}>
          <legend>Search {index + 1}</legend>
          <div className="jobsFormGrid">
            <label>
              Role or field
              <input required maxLength={120} value={row.lane} onChange={(event) => update(row.key, { lane: event.target.value })} />
            </label>
            <label>
              Location
              <input maxLength={120} placeholder="Remote, a city, or leave blank" value={row.location}
                onChange={(event) => update(row.key, { location: event.target.value })} />
            </label>
          </div>
          <label>
            Search words
            <textarea required minLength={8} maxLength={500} value={row.query} onChange={(event) => update(row.key, { query: event.target.value })} />
          </label>
          <label>
            Google Alert RSS feed address
            <input type="url" value={row.feedUrl} onChange={(event) => update(row.key, { feedUrl: event.target.value })} />
          </label>
          <label>
            <input type="checkbox" checked={row.enabled} onChange={(event) => update(row.key, { enabled: event.target.checked })} />
            Include in scans
          </label>
          <button type="button" onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}>
            Remove search {index + 1}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={rows.length >= 20}
        onClick={() => setRows((current) => [...current, { key: crypto.randomUUID(), lane: '', location: '', query: '', feedUrl: '', enabled: true }])}
      >
        Add a search
      </button>
      <button disabled={busy}>Save searches</button>
    </form>
  );
}

function Cockpit({ data }: { data: any }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState('');
  const segments = location.pathname.split('/').filter(Boolean);
  const active = (
    ['leads', 'truths', 'review', 'settings', 'workflow', 'excluded'].includes(segments[1]) ? segments[1] : 'today'
  ) as 'leads' | 'truths' | 'review' | 'settings' | 'today' | 'workflow' | 'excluded';
  const detail = segments[1] && !['leads', 'truths', 'review', 'settings', 'workflow', 'excluded'].includes(segments[1]);
  async function run(method: Method, args: unknown[] = [], reload = true) {
    setBusy(true);
    setError('');
    try {
      const next = await rpc(method, args);
      if (reload) location.reload();
      else setResult(JSON.stringify(next, null, 2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  }
  function form(method: Method, build: (form: HTMLFormElement) => unknown[], reload = true) {
    return (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void run(method, build(event.currentTarget), reload);
    };
  }
  return (
    <JobsShell active={active} truthReview={active === 'truths'} sessionLabel="Local session">
      {error && (
        <p role="alert">{error} Your saved state is retained. Review it before retrying.</p>
      )}
      {result && (
        <pre role="status" style={{ whiteSpace: 'pre-wrap' }}>
          {result}
        </pre>
      )}
      {active === 'workflow' || active === 'excluded' ? <WorkflowOverview data={data} busy={busy} run={run} excluded={active === 'excluded'} /> : active === 'truths' ? (
        (data as ReviewClaim[]).length ? (
          <>
            <TruthEditor claims={data as ReviewClaim[]} />
            <PasteClaims busy={busy} onSubmit={(text, note) => void run('truth.importText', [text, note])} heading="Add more claims" />
          </>
        ) : (
          <ResumeOnboarding busy={busy} onPaste={(text, note) => void run('truth.importText', [text, note])} />
        )
      ) : detail ? (
        <>
          {heading(
            String(data.lead?.title ?? 'Job details'),
            'Review the original posting and saved résumé snapshot before using a draft.',
          )}
          <p>
            <a href="/jobs/leads">Back to leads</a>
          </p>
          <WorkflowMaterials leadId={segments[1]} data={data.workflow} run={run} busy={busy} />
          <form
            className="jobsPanel"
            onSubmit={form('draft.posting', (f) => [
              segments[1],
              value(f, 'posting'),
              value(f, 'source'),
            ])}
          >
            <h2>Original posting</h2>
            <label>
              Posting text
              <textarea
                name="posting"
                rows={8}
                required
                minLength={200}
                maxLength={30000}
                defaultValue={data.lead?.postingText}
              />
            </label>
            <label>
              Source note
              <input
                name="source"
                required
                minLength={8}
                maxLength={500}
                defaultValue={data.lead?.postingSourceNote}
              />
            </label>
            <button disabled={busy}>Save verified posting</button>
          </form>
          {!data.approval?.materialManifestId && <section className="jobsPanel">
            <h2>Assessment</h2>
            <button disabled={busy} onClick={() => void run('draft.assess', [segments[1]], false)}>
              Assess and prepare draft
            </button>
            <p>Uses only your approved claims. Needs a provider and API key in Settings, or ask your AI assistant to prepare the draft instead.</p>
            <p>
              Monthly estimate: ${String(data.usage?.estimatedUsd ?? 0)} of $
              {String(data.usage?.budgetUsd ?? 8.5)}.
            </p>
          </section>}
          {data.history?.draft && (
            <section className="jobsPanel">
              <h2>Saved draft · {data.approval?.reviewStatus}</h2>
              {data.approval?.materialManifestId ? <>
                <p>These materials use exact approved claims. Ask your assistant to change the selection or ordering. To change a claim’s wording, review it in Résumé truths first.</p>
                <details><summary>Read the assembled résumé</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{data.history.draft.resumeVariant}</pre></details>
              </> : <form
                onSubmit={form('draft.edit', (f) => [
                  segments[1],
                  value(f, 'resume'),
                  value(f, 'outreach'),
                ])}
              >
                <label>
                  Résumé variant
                  <textarea
                    name="resume"
                    rows={9}
                    maxLength={12000}
                    defaultValue={data.history.draft.resumeVariant}
                  />
                </label>
                <label>
                  Outreach
                  <textarea
                    name="outreach"
                    rows={6}
                    maxLength={3000}
                    defaultValue={data.history.draft.outreach}
                  />
                </label>
                <button disabled={busy}>Save edits for review</button>
              </form>}
              <button
                disabled={busy}
                onClick={() => void run('draft.approve', [segments[1], data.approval.version])}
              >
                Approve this saved draft
              </button>
              {!data.approval?.materialManifestId && <button
                disabled={busy}
                onClick={() =>
                  void rpc('draft.pdf', [segments[1]])
                    .then((packet) => {
                      location.href = `/artifacts/${packet.id}`;
                    })
                    .catch((cause) => setError(cause.message))
                }
              >
                Download review packet
              </button>}
              <h3>Saved truth snapshot</h3>
              <ul>
                {data.history.draft.truthSnapshot.map((claim: SqlRow) => (
                  <li key={claim.id}>
                    {claim.claim}
                    <small> · {claim.sourceNote}</small>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : active === 'leads' ? (
        <>
          {heading(
            'Leads',
            'Imported leads stay unverified until you review the original posting.',
          )}
          <form
            className="jobsPanel"
            onSubmit={form('leads.add', (f) => [
              {
                url: value(f, 'url'),
                title: value(f, 'title'),
                organization: value(f, 'organization'),
                location: value(f, 'location'),
                notes: value(f, 'notes'),
              },
            ])}
          >
            <h2>Add a lead</h2>
            <div className="jobsFormGrid">
              <label>
                Posting URL
                <input type="url" name="url" required maxLength={2000} />
              </label>
              <label>
                Role title
                <input name="title" required maxLength={250} />
              </label>
              <label>
                Organization
                <input name="organization" maxLength={200} />
              </label>
              <label>
                Location
                <input name="location" maxLength={160} />
              </label>
            </div>
            <label>
              Notes
              <textarea name="notes" maxLength={4000} />
            </label>
            <button disabled={busy}>Save lead</button>
          </form>
          <form
            className="jobsPanel"
            onSubmit={form('batches.create', (f) => [new FormData(f).getAll('leadId').map(String)])}
          >
            <h2>Create a pursued batch</h2>
            {data
              .filter(
                (lead: SqlRow) => lead.decision === 'keep' && lead.applicationStage !== 'applied',
              )
              .map((lead: SqlRow) => (
                <label key={lead.id}>
                  <input type="checkbox" name="leadId" value={lead.id} />
                  {lead.title} · {lead.organization}
                </label>
              ))}
            <button disabled={busy}>Queue selected leads</button>
          </form>
          {data.map((lead: SqlRow) => (
            <section className="jobsPanel" key={lead.id}>
              <h2>
                <a href={`/jobs/${lead.id}`}>{lead.title}</a>
              </h2>
              <p>
                {lead.organization} · {lead.location} · {lead.verificationStatus}
              </p>
              <p>
                <a href={lead.sourceUrl} target="_blank" rel="noreferrer">
                  Original source
                </a>
              </p>
              <form
                onSubmit={form('leads.update', (f) => [
                  {
                    id: lead.id,
                    decision: value(f, 'decision'),
                    verification: lead.verificationStatus,
                    ...(value(f, 'stage') ? { stage: value(f, 'stage') } : {}),
                    notes: value(f, 'notes'),
                  },
                ])}
              >
                <label>
                  Decision
                  <select name="decision" defaultValue={lead.decision}>
                    <option value="review">Review</option>
                    <option value="keep">Pursue</option>
                    <option value="pass">Pass</option>
                  </select>
                </label>
                <label>
                  Stage
                  <select name="stage" defaultValue={lead.applicationStage ?? ''}>
                    <option value="">No stage</option>
                    {['researching', 'preparing', 'applied', 'interviewing', 'offer', 'closed'].map(
                      (stage) => (
                        <option key={stage}>{stage}</option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  Notes
                  <textarea name="notes" maxLength={4000} defaultValue={lead.notes} />
                </label>
                <button disabled={busy}>Save lead review</button>
              </form>
            </section>
          ))}
        </>
      ) : active === 'settings' ? (
        <>
          {heading('Settings', 'Searches, time zone and backups. Scans run only when you ask, while this computer is awake.')}
          <section className="jobsPanel">
            <h2>Feed status</h2>
            <p>
              {data.search.status.usage.callsUsed} of {data.search.status.usage.callCap} monthly polls used.
            </p>
            <button disabled={busy} onClick={() => void run('search.run', [], false)}>
              Scan feeds now
            </button>
            <p>One successful scan per UTC day; failed scans may be retried.</p>
          </section>
          <SearchEditor queries={data.search.queries} busy={busy} onSave={(rows) => void run('search.save', [rows])} />
          <form
            className="jobsPanel"
            onSubmit={form('settings.save', (f) => [{ timeZone: value(f, 'timeZone'), drafting: data.settings.drafting }])}
          >
            <h2>Time zone</h2>
            <p>Weekly reviews and application dates use this zone.</p>
            <label>
              Time zone
              <input name="timeZone" list="timeZones" required defaultValue={data.settings.timeZone} />
            </label>
            <datalist id="timeZones">
              {Intl.supportedValuesOf('timeZone').map((zone) => <option key={zone} value={zone} />)}
            </datalist>
            <button disabled={busy}>Save time zone</button>
          </form>
          <form
            className="jobsPanel"
            onSubmit={(event) => {
              event.preventDefault();
              const f = event.currentTarget;
              const provider = value(f, 'provider') as 'none' | 'openai' | 'anthropic';
              const key = value(f, 'apiKey');
              setBusy(true);
              setError('');
              void (async () => {
                try {
                  if (provider !== 'none' && key) await rpc('settings.saveApiKey', [provider, key]);
                  await rpc('settings.save', [{ timeZone: data.settings.timeZone, drafting: { provider, model: value(f, 'model') } }]);
                  location.reload();
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : 'Action failed.');
                  setBusy(false);
                }
              })();
            }}
          >
            <h2>Drafting in this app (optional)</h2>
            <p>
              You do not need this. Claude or ChatGPT can prepare drafts for you from your approved claims. Turn it on only if you
              want the <q>Assess and prepare draft</q> button here; it uses your own API key and stops at the monthly budget.
            </p>
            <label>
              Provider
              <select name="provider" defaultValue={data.settings.drafting.provider}>
                <option value="none">Off</option>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai">OpenAI</option>
              </select>
            </label>
            <label>
              Model
              <input name="model" maxLength={100} placeholder="Leave blank for the provider's default" defaultValue={data.settings.drafting.model} />
            </label>
            <label>
              API key
              <input name="apiKey" type="password" autoComplete="off" maxLength={500}
                placeholder={data.settings.apiKeys?.[data.settings.drafting.provider] ? 'Saved. Enter a new key to replace it.' : 'Paste your key'} />
            </label>
            <p>
              Keys stay in a private file on this computer, outside the database and its backups. Saved keys:{' '}
              {data.settings.apiKeys?.anthropic ? 'Anthropic ✓' : 'Anthropic none'} · {data.settings.apiKeys?.openai ? 'OpenAI ✓' : 'OpenAI none'}
            </p>
            <button disabled={busy}>Save drafting settings</button>
          </form>
          <section className="jobsPanel">
            <h2>Local backup</h2>
            <button disabled={busy} onClick={() => void run('backup', [], false)}>
              Create backup now
            </button>
            <p>Backups stay in the private local data directory.</p>
          </section>
        </>
      ) : active === 'review' ? (
        <>
          {heading('Weekly review', 'Confirmed receipts and user reports remain separate.')}
          <section className="jobsPanel">
            <h2>Confirmed activity</h2>
            {data.weeks.map((week: SqlRow) => (
              <p key={week.weekStart}>
                Week {String(week.weekStart).slice(0, 10)} · {week.applications} confirmed
                applications · {week.replies} replies · {week.interviews} interviews · {week.offers}{' '}
                offers{' '}
                <button
                  disabled={busy}
                  onClick={() => void run('review.complete', [String(week.weekStart).slice(0, 10)])}
                >
                  Mark reviewed
                </button>
              </p>
            ))}
          </section>
          <form
            className="jobsPanel"
            onSubmit={form('review.event', (f) => [
              {
                leadId: value(f, 'lead'),
                type: value(f, 'type'),
                date: value(f, 'date'),
                note: value(f, 'note'),
              },
            ])}
          >
            <h2>Record follow-up activity</h2>
            <label>
              Lead
              <select name="lead" required>
                {data.leads.map((lead: SqlRow) => (
                  <option key={lead.id} value={lead.id}>
                    {lead.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Activity
              <select name="type">
                {['kept', 'reply', 'interview', 'offer'].map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </label>
            <label>
              Date
              <input type="date" name="date" required />
            </label>
            <label>
              Evidence note
              <input name="note" maxLength={1000} />
            </label>
            <button disabled={busy}>Save activity</button>
          </form>
          <section className="jobsPanel">
            <h2>User-reported history</h2>
            {data.reports.map((report: SqlRow) => (
              <p key={report.id}>
                {report.organization} {report.external_job_id} ·{' '}
                {report.state === 'referral_expected'
                  ? 'Referral expected; unconfirmed'
                  : 'Submitted, reported by you'}
                <br />
                <small>{report.source_note}</small>
              </p>
            ))}
          </section>
        </>
      ) : (
        <>
          {heading(
            'Today',
            'Review your selected batch and resolve uncertain submissions before continuing.',
          )}
          {data.setup && (!data.setup.truths || !data.setup.reviewed || !data.setup.searches) && (
            <section className="jobsPanel" aria-labelledby="get-started">
              <h2 id="get-started">Get started</h2>
              <ol>
                <li>{data.setup.truths ? '✓ ' : ''}<a href="/jobs/truths">Add your résumé</a></li>
                <li>{data.setup.reviewed ? '✓ ' : ''}<a href="/jobs/truths">Review and approve your claims</a></li>
                <li>{data.setup.searches ? '✓ ' : ''}<a href="/jobs/settings">Add the job searches you want to follow</a></li>
                <li><a href="/jobs/leads">Save a job you want to apply for</a></li>
              </ol>
            </section>
          )}
          <section className="jobsPanel">
            <h2>Application batches</h2>
            {data.batches.batches.map((batch: SqlRow) => (
              <p key={batch.id}>
                {batch.itemCount} roles · {batch.queued} queued · {batch.submitted} confirmed{' '}
                <button disabled={busy} onClick={() => void run('batches.select', [batch.id])}>
                  {batch.isSelected ? 'Selected' : 'Select batch'}
                </button>
              </p>
            ))}
            {!data.batches.batches.length && (
              <p>
                No queued applications. <a href="/jobs/leads">Add and review leads</a>.
              </p>
            )}
          </section>
          {data.items.items.map((item: SqlRow) => (
            <section className="jobsPanel" key={item.itemId}>
              <h2>
                <a href={`/jobs/${item.leadId}`}>{item.title}</a>
              </h2>
              <p>
                {item.organization} · {item.status}
              </p>
              <p>{item.note}</p>
              {['blocked', 'skipped'].includes(item.status) && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run('items.requeue', [
                      item.itemId,
                      'User requested another preparation pass.',
                    ])
                  }
                >
                  Requeue preparation
                </button>
              )}
            </section>
          ))}
          {data.items.items.some((item: SqlRow) => item.status === 'blocked') && (
          <section className="jobsPanel">
            <h2>Submission reconciliation</h2>
            <p>
              After an interrupted submission, inspect the employer confirmation or application
              history before choosing an outcome. Do not click Submit again.
            </p>
            <form
              onSubmit={form('submission.notSubmitted', (f) => [
                value(f, 'attempt'),
                value(f, 'evidence'),
              ])}
            >
              <label>
                Attempt ID
                <input name="attempt" required />
              </label>
              <label>
                Evidence that no application was submitted
                <textarea name="evidence" required minLength={8} maxLength={1000} />
              </label>
              <button disabled={busy}>Record evidence; keep item blocked</button>
            </form>
          </section>
          )}
        </>
      )}
    </JobsShell>
  );
}

async function main() {
  const root = createRoot(document.getElementById('root')!);
  try {
    const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket');
    history.replaceState(null, '', location.pathname);
    const response = await nativeFetch(
      '/session',
      ticket
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket }),
          }
        : {},
    );
    const session = await response.json();
    if (!response.ok) throw new Error(session.error);
    csrf = session.csrf;
    const section = location.pathname.split('/')[2];
    let data: any;
    if (section === 'truths') data = await rpc('truth.list');
    else if (section === 'leads') data = await rpc('leads.list');
    else if (section === 'settings') data = { search: await rpc('search.settings'), settings: await rpc('settings.read') };
    else if (section === 'review') data = await rpc('review.read');
    else if (section === 'workflow' || section === 'excluded') {
      const offset = Math.max(0, Math.min(100000, Number(new URLSearchParams(location.search).get('offset')) || 0));
      const [runs, exclusionPage, workflow, jobs] = await Promise.all([rpc('collection.status'), rpc('exclusions.list', [{ offset }]), rpc('workflow.status', [{}]), rpc('workflow.jobs', [{}])]);
      data = { runs, exclusions: exclusionPage.exclusions, exclusionPage, workflow, jobs };
    }
    else if (section) {
      data = await rpc('draft.read', [section]);
      data.workflow = await rpc('workflow.status', [{ leadId: section }]);
      if (data.lead && (!data.lead.postingText || data.lead.verificationStatus === 'stale')) {
        let posting = '', offset: number | null = 0, postingHash: string | undefined;
        while (offset !== null) {
          const part = await rpc('workflow.posting', [{ leadId: section, offset, postingHash }]);
          posting += part.text; postingHash = part.postingHash; offset = part.nextOffset;
        }
        data.lead.postingText = posting;
      }
    }
    else {
      const [batches, claims, search] = await Promise.all([rpc('batches.list'), rpc('truth.list'), rpc('search.settings')]);
      data = {
        setup: {
          truths: claims.length,
          reviewed: claims.filter((claim: ReviewClaim) => claim.reviewStatus === 'reviewed').length,
          searches: search.queries.length,
        },
        batches,
        items: batches.selectedBatchId
          ? await rpc('batches.items', [batches.selectedBatchId])
          : { items: [] },
      };
    }
    root.render(<Cockpit data={data} />);
  } catch (error) {
    root.render(
      <main style={{ padding: '2rem' }}>
        <h1>Job Search Harness</h1>
        <p role="alert">
          {error instanceof Error ? error.message : 'Unable to open the workspace.'}
        </p>
        <p>Open Job Search Harness again from your AI assistant or its open command to start a private session.</p>
        <button onClick={() => location.reload()}>Retry</button>
      </main>,
    );
  }
}
void main();
