/* Standalone loopback UI uses ordinary document navigation. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import TruthEditor from './ui/truth-editor';
import JobsShell from './ui/jobs-shell';
import { WorkflowOverview } from './ui/workflow';
import { Today } from './ui/today';
import { Leads } from './ui/leads';
import { Detail } from './ui/detail';
import { WeeklyReview } from './ui/review';
import { Reconcile } from './ui/reconcile';
import { Settings } from './ui/settings';
import { Welcome, WELCOMED_KEY } from './ui/welcome';
import { useLive, useNow, type LiveState } from './ui/live';
import type { Pipeline, Run } from './ui/common';
import type { ReviewClaim } from '../../lib/resume-truth-review';
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
  <header className="jobsPageHeader ck-head">
    <div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
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

const SECTIONS = ['leads', 'truths', 'review', 'settings', 'workflow', 'excluded', 'reconcile', 'welcome'] as const;
type Section = (typeof SECTIONS)[number];
const loadLive = () => rpc('cockpit.live') as Promise<LiveState>;

function Cockpit({ data }: { data: any }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState('');
  const { live, offline, skew } = useLive(loadLive);
  const now = useNow(skew);
  const segments = location.pathname.split('/').filter(Boolean);
  const active: Section | 'today' = (SECTIONS as readonly string[]).includes(segments[1]) ? segments[1] as Section : 'today';
  const detail = segments[1] && !(SECTIONS as readonly string[]).includes(segments[1]);
  const run: Run = async (method, args = [], reload = true) => {
    setBusy(true);
    setError('');
    setResult('');
    try {
      const next = await rpc(method, args);
      if (typeof reload === 'string') location.assign(reload);
      else if (reload) location.reload();
      else setResult(JSON.stringify(next, null, 2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };
  const job = detail ? (data.pipeline as Pipeline | undefined)?.jobs.find((item) => item.id === segments[1]) : undefined;
  return (
    <JobsShell active={detail ? 'leads' : active} truthReview={active === 'truths'} sessionLabel="Local session"
      crumb={detail ? [data.lead?.title, data.lead?.organization].filter(Boolean).join(' · ') : undefined} live={live} offline={offline} now={now}>
      {error && <p role="alert" className="ck-alert">{error} Your saved state is retained. Review it before retrying.</p>}
      {result && <div role="status" className="ck-notice"><strong>Done.</strong>
        <details><summary>Show details</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result}</pre></details></div>}
      {active === 'workflow' || active === 'excluded' ? <WorkflowOverview data={data} busy={busy} run={run} excluded={active === 'excluded'} />
        : active === 'truths' ? (
          (data as ReviewClaim[]).length ? <>
            <TruthEditor claims={data as ReviewClaim[]} />
            <PasteClaims busy={busy} onSubmit={(text, note) => void run('truth.importText', [text, note])} heading="Add more claims" />
          </> : <ResumeOnboarding busy={busy} onPaste={(text, note) => void run('truth.importText', [text, note])} />
        ) : detail ? <Detail leadId={segments[1]} data={data} job={job} live={live} now={now} run={run} busy={busy}
          rpcDownload={() => void rpc('draft.pdf', [segments[1]]).then((packet) => { location.href = `/artifacts/${packet.id}`; }).catch((cause) => setError(cause.message))} />
          : active === 'leads' ? <Leads leads={data.leads} pipeline={data.pipeline} run={run} busy={busy} />
            : active === 'settings' ? <Settings data={data} run={run} rpc={rpc} busy={busy} setBusy={setBusy} setError={setError} />
              : active === 'review' ? <WeeklyReview data={data} pipeline={data.pipeline} run={run} busy={busy} />
                : active === 'reconcile' ? <Reconcile data={data} run={run} busy={busy} />
                  : active === 'welcome' ? <Welcome data={data} rpc={rpc} />
                  : <Today data={data} live={live} now={now} run={run} busy={busy} />}
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
    else if (section === 'leads') {
      const [leads, pipeline] = await Promise.all([rpc('leads.list'), rpc('cockpit.pipeline')]);
      data = { leads, pipeline };
    }
    else if (section === 'settings') data = { search: await rpc('search.settings'), settings: await rpc('settings.read') };
    else if (section === 'review') {
      const [review, pipeline, settings] = await Promise.all([rpc('review.read'), rpc('cockpit.pipeline'), rpc('settings.read')]);
      data = { ...review, pipeline, timeZone: settings.timeZone };
    }
    else if (section === 'reconcile') data = await rpc('cockpit.reconcile');
    else if (section === 'welcome') {
      const [assistants, settings, search, workflow, claims] = await Promise.all([rpc('assistant.status'), rpc('settings.read'),
        rpc('search.settings'), rpc('workflow.settings'), rpc('truth.list')]);
      data = { assistants, settings, search, workflow, truthCount: claims.length };
    }
    else if (section === 'workflow' || section === 'excluded') {
      const offset = Math.max(0, Math.min(100000, Number(new URLSearchParams(location.search).get('offset')) || 0));
      const [runs, exclusionPage, workflow, jobs, pipeline] = await Promise.all([rpc('collection.status'), rpc('exclusions.list', [{ offset }]),
        rpc('workflow.status', [{}]), rpc('workflow.jobs', [{}]), rpc('cockpit.pipeline')]);
      data = { runs, exclusions: exclusionPage.exclusions, exclusionPage, workflow, jobs, pipeline };
    }
    else if (section) {
      data = await rpc('draft.read', [section]);
      const [workflow, view, pipeline, leads] = await Promise.all([rpc('workflow.status', [{ leadId: section }]), rpc('cockpit.lead', [section]),
        rpc('cockpit.pipeline'), rpc('leads.list')]);
      Object.assign(data, { workflow, view, pipeline, leadRow: leads.find((lead: { id: string }) => lead.id === section) });
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
      const [batches, claims, search, pipeline, review, reconcile] = await Promise.all([rpc('batches.list'), rpc('truth.list'), rpc('search.settings'),
        rpc('cockpit.pipeline'), rpc('review.read'), rpc('cockpit.reconcile')]);
      let welcomed = true;
      try { welcomed = Boolean(localStorage.getItem(WELCOMED_KEY)); } catch { /* storage is optional */ }
      // A brand-new workspace opens on the setup guide once.
      if (!welcomed && !claims.length && !search.queries.length) { location.replace('/jobs/welcome'); return; }
      data = {
        setup: {
          truths: claims.length,
          reviewed: claims.filter((claim: ReviewClaim) => claim.reviewStatus === 'reviewed').length,
          unreviewed: claims.filter((claim: ReviewClaim) => claim.reviewStatus === 'unreviewed').length,
          searches: search.queries.length,
        },
        batches,
        pipeline,
        review,
        reconcileCount: reconcile.attempts.filter((attempt: { state: string }) => attempt.state !== 'not_submitted').length,
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
