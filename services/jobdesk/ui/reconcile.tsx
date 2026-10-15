import { useState } from 'react';
import { PageHead, type Run } from './common';

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const kindTone: Record<string, string> = { error: 't-bad', needs_you: 't-bad', receipt: 't-ok', saved: 't-ok', lease: 't-accent' };

function Attempt({ attempt, run, busy }: { attempt: any; run: Run; busy: boolean }) {
  const [outcome, setOutcome] = useState<'found' | 'none' | null>(null);
  const [evidence, setEvidence] = useState('');
  const name = `outcome-${attempt.attemptId}`;
  const timeline = [
    { at: attempt.createdAt, title: 'Attempt began, bound to the approved draft', tool: 'job_hunt_begin_submission', tone: 't-ok' },
    ...attempt.log.filter((event: any) => !['items.read', 'submission.begin'].includes(event.method))
      .map((event: any) => ({ at: event.at, title: event.summary, tool: event.tool || event.method, tone: kindTone[event.kind] ?? 't-muted' })),
    ...(attempt.note ? [{ at: attempt.updatedAt, title: attempt.note, tool: attempt.state === 'uncertain' ? 'Marked uncertain' : 'Pending', tone: 't-bad' }] : []),
  ];
  return <section className="ck-grid" aria-label={`${attempt.title} submission`}>
    <div className="ck-card">
      <div><h2>{attempt.title}</h2><span className="ck-muted">{[attempt.organization, attempt.location].filter(Boolean).join(' · ')}</span></div>
      <dl className="ck-meta">
        <dt>Attempt</dt><dd className="ck-mono">{attempt.attemptId}</dd>
        <dt>Draft</dt><dd className="ck-mono">{attempt.draftVersion ?? 'unknown'} · {String(attempt.draftHash ?? '').slice(0, 4)}…{String(attempt.draftHash ?? '').slice(-4)}</dd>
        <dt>State</dt><dd>{attempt.state === 'uncertain' ? 'Uncertain' : 'Pending'}</dd>
      </dl>
      <ol className="ck-timeline">{timeline.map((entry, index) => <li key={index}>
        <span className="ck-mono ck-faint">{time(entry.at)}</span><span className={`ck-dot ${entry.tone}`} aria-hidden="true" />
        <span style={{ display: 'grid' }}><strong>{entry.title}</strong><span className="ck-mono ck-faint" style={{ fontSize: '.875rem' }}>{entry.tool}</span></span>
      </li>)}</ol>
    </div>
    <fieldset className="ck-card" style={{ margin: 0 }}>
      <legend className="sr-only">What did the employer show?</legend>
      <h2 aria-hidden="true">What did the employer show?</h2>
      <label className="ck-option"><input type="radio" name={name} checked={outcome === 'found'} onChange={() => setOutcome('found')} />
        <span><strong>I found the employer’s confirmation</strong><span>Your assistant records the receipt. The item is marked submitted and counted this week.</span></span></label>
      <label className="ck-option"><input type="radio" name={name} checked={outcome === 'none'} onChange={() => setOutcome('none')} />
        <span><strong>Nothing was submitted</strong><span>Record your evidence. The item stays blocked until you requeue it deliberately.</span></span></label>
      {outcome === 'found' && <div className="ck-notice">
        <p style={{ marginTop: 0 }}>Receipts are recorded only over the worker connection, so the confirmation stays bound to this exact attempt. Tell your assistant:</p>
        <p style={{ marginBottom: 0 }}><q>Record the receipt for {attempt.title} at {attempt.organization}. The employer’s confirmation is: …</q></p>
      </div>}
      {outcome === 'none' && <form className="ck-stack" style={{ gap: '.6rem' }} onSubmit={(event) => { event.preventDefault(); void run('submission.notSubmitted', [attempt.attemptId, evidence]); }}>
        <label>Evidence that no application was submitted<textarea rows={3} required minLength={8} maxLength={1000} value={evidence} onChange={(event) => setEvidence(event.target.value)} /></label>
        <button className="ck-btn ck-btn--primary" style={{ alignSelf: 'flex-start' }} disabled={busy}>Record evidence; keep item blocked</button>
      </form>}
      {!outcome && <button type="button" className="ck-btn" style={{ alignSelf: 'flex-start' }} disabled>Choose an outcome</button>}
    </fieldset>
  </section>;
}

export function Reconcile({ data, run, busy }: { data: any; run: Run; busy: boolean }) {
  const open = data.attempts.filter((attempt: any) => attempt.state !== 'not_submitted');
  const settled = data.attempts.filter((attempt: any) => attempt.state === 'not_submitted');
  return <>
    <PageHead title="Submission reconciliation" kicker={open.length ? `${open.length} submission${open.length === 1 ? ' is' : 's are'} uncertain` : 'All clear'} kickerTone={open.length ? 't-bad' : 't-ok'}
      description="After an interrupted submission, inspect the employer confirmation or application history before choosing an outcome." />
    {open.length > 0 && <div className="ck-alert" role="alert">Do not click Submit again on the employer’s site. Each item stays blocked until you choose an outcome.</div>}
    {!data.attempts.length && <div className="ck-empty"><p><strong>Nothing to reconcile.</strong></p><p>Interrupted submissions appear here and block further work until you resolve them.</p></div>}
    {open.map((attempt: any) => <Attempt key={attempt.attemptId} attempt={attempt} run={run} busy={busy} />)}
    {settled.length > 0 && <section className="ck-card" aria-labelledby="settled-title">
      <h2 id="settled-title">No submission confirmed</h2>
      <p className="ck-muted" style={{ margin: 0 }}>You recorded that nothing was submitted. Requeue only if you want your assistant to prepare the role again.</p>
      <div className="ck-divided">{settled.map((attempt: any) => <div key={attempt.attemptId} className="ck-row" style={{ justifyContent: 'space-between' }}>
        <span><a href={`/jobs/${attempt.leadId}`}>{attempt.title}</a> <span className="ck-muted">{attempt.organization}</span></span>
        <button className="ck-btn ck-btn--small" disabled={busy} onClick={() => void run('items.requeue', [attempt.itemId, 'User requested another preparation pass after reconciliation.'])}>Requeue preparation</button>
      </div>)}</div>
    </section>}
  </>;
}
