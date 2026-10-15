import { useState } from 'react';
import { jobStatus, PageHead, Status, STAGES, type Pipeline, type PipelineJob, type Run } from './common';
import { clock, leaseLeft, type LiveState } from './live';

type Layout = 'board' | 'mission' | 'journeys';
const LAYOUT_KEY = 'jobdesk.today';
const layouts: [Layout, string][] = [['board', 'Board'], ['mission', 'Mission control'], ['journeys', 'Journeys']];
const savedLayout = (): Layout => { try { const v = localStorage.getItem(LAYOUT_KEY); return v === 'board' || v === 'journeys' ? v : 'mission'; } catch { return 'mission'; } };

type StepState = 'done' | 'run' | 'you' | 'next' | 'wait';
function missionSteps(job: PipelineJob) {
  const defs: [string, string, boolean][] = [
    ['Claim preparation lease', 'job_hunt_update_item_status', Boolean(job.itemId && job.itemStatus !== 'queued')],
    ['Assess the posting', 'job_hunt_get_work_packet → job_hunt_save_work_result', Boolean(job.recommendation)],
    ['Select approved claims', 'job_hunt_lookup_claims → job_hunt_save_work_result', job.selectionState === 'complete'],
    ['Build materials', 'job_hunt_build_materials', job.materialState === 'current'],
    ['Your rendered review', 'You, in Job detail', job.validation?.visual === 'passed'],
    ['Your approval', 'You, in Job detail', job.draftStatus === 'approved'],
  ];
  const current = defs.findIndex(([, , done]) => !done);
  return defs.map(([label, tool, done], index): { label: string; tool: string; state: StepState } => ({
    label, tool,
    state: done && (current === -1 || index < current) ? 'done' : index === current ? (index >= 4 ? 'you' : job.leased ? 'run' : 'next') : done ? 'done' : 'wait',
  }));
}
const stepText: Record<StepState, string> = { done: 'Done', run: 'Running', you: 'Needs you', next: 'Up next', wait: 'Waiting' };
const stepGlyph: Record<StepState, string> = { done: '✓', run: '●', you: '!', next: '', wait: '' };

export function Today({ data, live, now, run, busy }: { data: any; live: LiveState | null; now: number; run: Run; busy: boolean }) {
  const [layout, setLayout] = useState<Layout>(savedLayout);
  const pipeline: Pipeline = data.pipeline;
  const jobs = pipeline.jobs;
  const choose = (next: Layout) => { setLayout(next); try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* optional */ } };
  const leasedIds = new Set((live?.leases ?? []).map((lease) => lease.leadId));
  const isLeased = (job: PipelineJob) => leasedIds.has(job.id) || (!live && job.leased);
  const withLive = jobs.map((job) => ({ ...job, leased: isLeased(job) }));
  const reviewJob = withLive.find((job) => job.materialState === 'current' && job.validation?.visual !== 'passed')
    ?? withLive.find((job) => jobStatus(job).label === 'Awaiting you');
  const counts = live?.counts;
  const tiles = [
    (counts?.reconcile ?? data.reconcileCount) > 0 && { tone: 'bad', kicker: 'Blocked', title: 'Reconcile an uncertain submission', body: 'A submission was interrupted. Check the employer’s site before anything else happens.', cta: 'Check and resolve', href: '/jobs/reconcile' },
    reviewJob && { tone: 'accent', kicker: 'Awaiting you', title: reviewJob.materialState === 'current' && reviewJob.validation?.visual !== 'passed' ? 'Inspect rendered pages' : 'Approve prepared materials', body: `${reviewJob.organization || reviewJob.title} · materials are ready for your review.`, cta: 'Open materials', href: `/jobs/${reviewJob.id}` },
    (counts?.truths ?? data.setup.unreviewed) > 0 && { tone: 'muted', kicker: 'To review', title: `${counts?.truths ?? data.setup.unreviewed} new résumé claims`, body: 'Unreviewed claims cannot be used in drafts.', cta: 'Review claims', href: '/jobs/truths' },
  ].filter(Boolean) as { tone: string; kicker: string; title: string; body: string; cta: string; href: string }[];
  const focus = withLive.find((job) => job.leased)
    ?? withLive.find((job) => job.itemId && ['preparing', 'awaiting_approval'].includes(job.itemStatus ?? ''))
    ?? withLive.find((job) => job.itemStatus === 'queued');
  const preparing = withLive.filter((job) => job.leased).length;
  const week = data.review?.weeks?.[0];
  const setupDone = data.setup.truths && data.setup.reviewed && data.setup.searches;
  const items: any[] = data.items.items;
  return <>
    <PageHead kicker={new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} title="Today"
      description={jobs.length ? `${jobs.length} active role${jobs.length === 1 ? '' : 's'}. ${preparing ? 'Your assistant is preparing one now; ' : ''}${tiles.length ? `${tiles.length} thing${tiles.length === 1 ? ' needs' : 's need'} you.` : 'Nothing needs you right now.'}` : 'Review your selected batch and resolve uncertain submissions before continuing.'}>
      <div className="ck-segmented" role="group" aria-label="Today layout">
        {layouts.map(([id, label]) => <button key={id} type="button" aria-pressed={layout === id} onClick={() => choose(id)}>{label}</button>)}
      </div>
    </PageHead>

    {!setupDone && <section className="ck-card ck-card--strong" aria-labelledby="get-started">
      <div className="ck-card-head"><h2 id="get-started">Get started</h2><a className="ck-btn ck-btn--primary ck-btn--small" href="/jobs/welcome">Open the setup guide</a></div>
      <ol className="ck-stack" style={{ margin: 0, paddingLeft: '1.4rem', gap: '.4rem' }}>
        <li>{data.setup.truths ? '✓ ' : ''}<a href="/jobs/truths">Add your résumé</a></li>
        <li>{data.setup.reviewed ? '✓ ' : ''}<a href="/jobs/truths">Review and approve your claims</a></li>
        <li>{data.setup.searches ? '✓ ' : ''}<a href="/jobs/settings">Add the job searches you want to follow</a></li>
        <li><a href="/jobs/leads">Save a job you want to apply for</a></li>
      </ol>
    </section>}

    <section className="ck-tiles" aria-label="Needs you">
      {tiles.length ? tiles.map((tile) => <a key={tile.title} className={`ck-tile ck-tile--${tile.tone}`} href={tile.href}>
        <span className="ck-label">{tile.kicker}</span><strong>{tile.title}</strong><span>{tile.body}</span>
        <span className="ck-tile-cta">{tile.cta} →</span>
      </a>) : <div className="ck-tile"><span className="ck-label">All clear</span><strong>Nothing is waiting on you</strong><span>Your assistant’s progress shows up in the activity panel as it works.</span></div>}
    </section>

    {!jobs.length ? <div className="ck-empty"><p><strong>No active roles yet.</strong></p><p><a href="/jobs/leads">Add and review leads</a>, or ask your assistant to collect jobs.</p></div>
      : layout === 'board' ? <Board jobs={withLive} />
        : layout === 'journeys' ? <Journeys jobs={withLive} />
          : <section className="ck-grid" aria-label="Mission control">
            <Mission job={focus} live={live} now={now} />
            <div className="ck-stack">
              <div className="ck-card">
                <span className="ck-label">Pipeline at a glance</span>
                {STAGES.map((name, index) => {
                  const n = withLive.filter((job) => job.stage === index).length;
                  const max = Math.max(1, ...STAGES.map((_, i) => withLive.filter((job) => job.stage === i).length));
                  return <div className="ck-barrow" key={name}><span className="ck-muted">{name}</span>
                    <div className={`ck-meter${index === 3 ? '' : ' ck-meter--muted'}`}><span style={{ width: `${(n / max) * 100}%` }} /></div><strong>{n}</strong></div>;
                })}
              </div>
              {week && <div className="ck-card">
                <span className="ck-label">This week, confirmed</span>
                <div className="ck-stats">
                  <div><strong className="t-accent">{week.applications}</strong><span>receipts</span></div>
                  <div><strong>{week.replies}</strong><span>replies</span></div>
                  <div><strong>{week.interviews}</strong><span>interviews</span></div>
                </div>
              </div>}
            </div>
          </section>}

    <section className="ck-card" aria-labelledby="batches-title">
      <div className="ck-card-head"><h2 id="batches-title">Application batches</h2><a className="ck-link" href="/jobs/leads">Queue more from Leads</a></div>
      {!data.batches.batches.length && <p className="ck-muted" style={{ margin: 0 }}>No queued applications. <a href="/jobs/leads">Add and review leads</a>.</p>}
      <div className="ck-divided">
        {data.batches.batches.map((batch: any) => <div key={batch.id} className="ck-row" style={{ justifyContent: 'space-between' }}>
          <span>{batch.itemCount} roles · {batch.queued} queued · {batch.submitted} confirmed</span>
          <button className="ck-btn ck-btn--small" aria-pressed={Boolean(batch.isSelected)} disabled={busy || batch.isSelected} onClick={() => void run('batches.select', [batch.id])}>
            {batch.isSelected ? 'Selected' : 'Select batch'}</button>
        </div>)}
        {items.map((item) => <div key={item.itemId} className="ck-row" style={{ justifyContent: 'space-between' }}>
          <span><a href={`/jobs/${item.leadId}`}>{item.title}</a> <span className="ck-muted">{item.organization} · {item.status}</span></span>
          {['blocked', 'skipped'].includes(item.status) && <button className="ck-btn ck-btn--small" disabled={busy}
            onClick={() => void run('items.requeue', [item.itemId, 'User requested another preparation pass.'])}>Requeue preparation</button>}
        </div>)}
      </div>
    </section>
  </>;
}

function Board({ jobs }: { jobs: PipelineJob[] }) {
  return <section className="ck-scroll" aria-label="Board: roles by stage" tabIndex={0}>
    <div className="ck-board">
      {STAGES.map((name, index) => {
        const column = jobs.filter((job) => job.stage === index);
        return <div className="ck-col" key={name}>
          <h2 className={`ck-col-head${index === 3 ? ' ck-col-head--active' : ''}`} style={{ margin: 0, fontSize: 'inherit' }}>
            <span className="ck-label">{name}</span> <strong>{column.length}</strong></h2>
          {column.map((job) => {
            const status = jobStatus(job);
            return <a key={job.id} href={`/jobs/${job.id}`} className={`ck-job${job.leased ? ' ck-job--live' : status.tone === 't-bad' ? ' ck-job--bad' : ''}`}>
              <strong>{job.title}</strong><span>{job.organization || 'Employer unknown'}</span><Status {...status} />
            </a>;
          })}
          {!column.length && <span className="ck-col-empty">None</span>}
        </div>;
      })}
    </div>
  </section>;
}

function Mission({ job, live, now }: { job?: PipelineJob; live: LiveState | null; now: number }) {
  if (!job) return <div className="ck-card ck-card--strong">
    <span className="ck-kicker">Assistant</span>
    <h2>Nothing is being prepared</h2>
    <p className="ck-muted" style={{ margin: 0 }}>Queue chosen roles as a pursued batch, then ask your assistant to prepare the next one. Its progress appears here step by step.</p>
    <a className="ck-btn ck-btn--primary" style={{ alignSelf: 'flex-start' }} href="/jobs/leads">Go to Leads</a>
  </div>;
  const lease = live?.leases.find((item) => item.leadId === job.id);
  const left = lease ? leaseLeft(lease.expiresAt, now) : 0;
  return <div className="ck-card ck-card--strong" style={{ gap: '1.1rem' }}>
    <div className="ck-mission-top">
      <div style={{ display: 'grid', gap: '.35rem' }}>
        <span className="ck-kicker">{job.leased ? 'Assistant is preparing' : jobStatus(job).label === 'Queued' ? 'Up next' : 'In progress'}</span>
        <h2>{job.title}</h2>
        <span className="ck-muted">{[job.organization, job.location].filter(Boolean).join(' · ')}</span>
      </div>
      {lease ? <div className="ck-lease" role="timer" aria-label={`Lease remaining ${clock(left)}`}>
        <strong>{clock(left)}</strong><span className="ck-muted">Lease remaining</span>
        <div className="ck-meter"><span style={{ width: `${Math.min(100, (left / 120) * 100)}%` }} /></div>
      </div> : <span className="ck-pill">No active lease</span>}
    </div>
    <ol className="ck-steps">
      {missionSteps(job).map((step) => <li key={step.label} data-state={step.state}>
        <span className="ck-step-dot" aria-hidden="true">{stepGlyph[step.state]}</span>
        <span><strong>{step.label}</strong><span className="ck-step-tool">{step.tool}</span></span>
        <span className="ck-step-state">{stepText[step.state]}</span>
      </li>)}
    </ol>
    <div className="ck-row">
      <a className="ck-btn ck-btn--primary" href={`/jobs/${job.id}`}>Open job</a>
      <span className="ck-muted" style={{ fontSize: '1rem' }}>Materials use your exact approved wording. Nothing is sent until you approve.</span>
    </div>
  </div>;
}

function Journeys({ jobs }: { jobs: PipelineJob[] }) {
  return <section className="ck-card ck-card--flush ck-scroll" aria-label="Journeys: each role on its track" tabIndex={0}>
    <div className="ck-journeys" role="table" aria-label="Role journeys">
      <div className="ck-jrow ck-jrow--head" role="row">
        <span className="ck-label" role="columnheader">Role</span>
        <div className="ck-stage-names" role="columnheader">{STAGES.map((name) => <span key={name}>{name}</span>)}</div>
        <span className="ck-label" role="columnheader" style={{ textAlign: 'right' }}>Next</span>
      </div>
      {jobs.map((job) => {
        const status = jobStatus(job), bad = status.tone === 't-bad';
        return <div className="ck-jrow" role="row" key={job.id}>
          <span role="cell"><a href={`/jobs/${job.id}`}><strong>{job.title}</strong><span>{[job.organization, job.location].filter(Boolean).join(' · ')}</span></a></span>
          <div className="ck-track" role="cell" aria-label={`Stage ${job.stage + 1} of 6: ${STAGES[job.stage]}`}>
            <span className={`ck-track-fill${bad ? ' ck-track-fill--bad' : ''}`} style={{ width: `${(job.stage / 5) * 83.33}%` }} />
            {STAGES.map((name, index) => <span key={name} aria-hidden="true"
              className={`ck-node${index < job.stage ? ' ck-node--done' : index === job.stage ? ` ck-node--here${bad ? ' ck-node--bad' : ''}` : ''}`}>{index < job.stage ? '✓' : ''}</span>)}
          </div>
          <span role="cell" className={`ck-jnext ${status.tone}`}>{status.label}</span>
        </div>;
      })}
    </div>
  </section>;
}
