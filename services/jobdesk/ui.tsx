/* Standalone loopback UI uses ordinary document navigation, not Next routing. */
/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-location-assign-relative-destination */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import TruthEditor from '../../app/jobs/truth-editor';
import JobsShell from '../../app/jobs/jobs-shell';
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

function Cockpit({ data }: { data: any }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState('');
  const segments = location.pathname.split('/').filter(Boolean);
  const active = (
    ['leads', 'truths', 'review', 'settings'].includes(segments[1]) ? segments[1] : 'today'
  ) as 'leads' | 'truths' | 'review' | 'settings' | 'today';
  const detail = segments[1] && !['leads', 'truths', 'review', 'settings'].includes(segments[1]);
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
      {active === 'truths' ? (
        <TruthEditor claims={data as ReviewClaim[]} />
      ) : detail ? (
        <>
          {heading(
            String(data.lead?.title ?? 'Job details'),
            'Review the original posting and saved résumé snapshot before using a draft.',
          )}
          <p>
            <a href="/jobs/leads">Back to leads</a>
          </p>
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
          <section className="jobsPanel">
            <h2>Assessment</h2>
            <button disabled={busy} onClick={() => void run('draft.assess', [segments[1]], false)}>
              Assess and prepare draft
            </button>
            <p>Uses your reviewed claims. Provider access requires an existing configured key.</p>
            <p>
              Monthly estimate: ${String(data.usage?.estimatedUsd ?? 0)} of $
              {String(data.usage?.budgetUsd ?? 8.5)}.
            </p>
          </section>
          {data.history?.draft && (
            <section className="jobsPanel">
              <h2>Saved draft · {data.approval?.reviewStatus}</h2>
              <form
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
              </form>
              <button
                disabled={busy}
                onClick={() => void run('draft.approve', [segments[1], data.approval.version])}
              >
                Approve this saved draft
              </button>
              <button
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
              </button>
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
          {heading('Search settings', 'Scans run when requested while this Mac is awake.')}
          <section className="jobsPanel">
            <h2>Feed status</h2>
            <p>
              {data.status.usage.callsUsed} of {data.status.usage.callCap} monthly polls used.
            </p>
            <button disabled={busy} onClick={() => void run('search.run', [], false)}>
              Scan feeds now
            </button>
            <p>One successful scan per UTC day; failed scans may be retried.</p>
          </section>
          <form
            className="jobsPanel"
            onSubmit={form('search.save', (f) => [
              data.queries.map((query: SqlRow) => ({
                id: query.id,
                query: value(f, `query:${query.id}`),
                feedUrl: value(f, `feed:${query.id}`),
                enabled: new FormData(f).has(`enabled:${query.id}`),
              })),
            ])}
          >
            <h2>Google Alerts feeds</h2>
            {data.queries.map((query: SqlRow) => (
              <fieldset key={query.id}>
                <legend>
                  {query.lane} · {query.location}
                </legend>
                <label>
                  Reference terms
                  <textarea
                    name={`query:${query.id}`}
                    required
                    minLength={8}
                    maxLength={500}
                    defaultValue={query.query}
                  />
                </label>
                <label>
                  Google Alert RSS URL
                  <input name={`feed:${query.id}`} type="url" defaultValue={query.feedUrl} />
                </label>
                <label>
                  <input
                    type="checkbox"
                    name={`enabled:${query.id}`}
                    defaultChecked={query.enabled}
                  />
                  Enable feed
                </label>
              </fieldset>
            ))}
            <button disabled={busy}>Save settings</button>
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
    else if (section === 'settings') data = await rpc('search.settings');
    else if (section === 'review') data = await rpc('review.read');
    else if (section) data = await rpc('draft.read', [section]);
    else {
      const batches = await rpc('batches.list');
      data = {
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
        <h1>Local Job Desk</h1>
        <p role="alert">
          {error instanceof Error ? error.message : 'Unable to open the workspace.'}
        </p>
        <p>Start Jobdesk and use its local open command to launch a private session.</p>
        <button onClick={() => location.reload()}>Retry</button>
      </main>,
    );
  }
}
void main();
