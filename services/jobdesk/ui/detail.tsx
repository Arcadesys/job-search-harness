import { useState } from 'react';
import { decisionLabel, recommendationLabel, STAGES, verificationLabel, type PipelineJob, type Run } from './common';
import { leadUpdate } from './leads';
import { clock, leaseLeft, type LiveState } from './live';

const labels: Record<string, string> = { current: 'Current', stale: 'Stale', partial: 'Partial', failed: 'Failed', passed: 'Passed', complete: 'Complete', pending: 'Pending', needs_attention: 'Needs attention', running: 'Running' };
const tone = (state?: string) => state === 'passed' || state === 'current' ? 't-ok' : state === 'failed' || state === 'needs_attention' ? 't-bad' : 't-accent';
const field = (form: HTMLFormElement, name: string) => String(new FormData(form).get(name) ?? '').trim();
const artifactName: Record<string, string> = { resume: 'Employer résumé', outreach: 'Outreach draft', review: 'Private review packet' };

/** Highlight the assessment's quoted evidence inside the saved posting. */
function Highlighted({ text, quotes }: { text: string; quotes: string[] }) {
  const usable = quotes.filter((quote) => quote.length >= 6 && text.includes(quote));
  if (!usable.length) return <>{text}</>;
  const pattern = new RegExp(`(${usable.map((quote) => quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  return <>{text.split(pattern).map((part, index) => usable.includes(part) ? <mark key={index}>{part}</mark> : part)}</>;
}

export function Detail({ leadId, data, job, live, now, run, rpcDownload, busy }: {
  leadId: string; data: any; job?: PipelineJob; live: LiveState | null; now: number; run: Run; rpcDownload: () => void; busy: boolean;
}) {
  const [tab, setTab] = useState<'resume' | 'outreach' | 'packet'>('resume');
  const lead = data.lead ?? {};
  const row = data.leadRow ?? { id: leadId, decision: 'review', verificationStatus: lead.verificationStatus ?? 'unverified' };
  const assessment = data.view?.assessment;
  const material = data.workflow.materials[0];
  const draft = data.history?.draft;
  const bound = Boolean(data.approval?.materialManifestId);
  const stage = job?.stage ?? 0;
  const lease = live ? live.leases.find((item) => item.leadId === leadId) : data.view?.lease;
  const verification = verificationLabel(String(lead.verificationStatus ?? 'unverified'));
  const rec = recommendationLabel(assessment?.recommendation);
  const reviewed = material?.validation?.visual === 'passed';
  const approved = data.approval?.reviewStatus === 'approved';
  const canApprove = Boolean(draft) && !approved && (!bound || reviewed);
  const quotes: string[] = (assessment?.reasons ?? []).map((reason: any) => String(reason.evidence ?? ''));
  const paper = tab === 'resume' ? draft?.resumeVariant : tab === 'outreach' ? draft?.outreach : null;
  return <>
    <div className="ck-stack" style={{ gap: '.6rem' }}>
      <a className="ck-link" href="/jobs/leads">← Back to leads</a>
      <header className="ck-head">
        <div>
          <h1>{String(lead.title ?? 'Job details')}</h1>
          <p>{[lead.organization, lead.location].filter(Boolean).join(' · ')}{lead.sourceUrl && <> · <a href={lead.sourceUrl} target="_blank" rel="noreferrer">Original source</a></>}</p>
        </div>
        <div className="ck-row">
          <span className={`ck-pill ${verification.tone}`}><span className="ck-dot" aria-hidden="true" /><span className="t-text">Posting {verification.label.toLowerCase()}</span></span>
          {lease && <span className="ck-pill ck-pill--accent" role="timer">Lease held by your assistant · {clock(leaseLeft(lease.expiresAt, now))}</span>}
        </div>
      </header>
    </div>
    <div className="ck-stagebar" role="list" aria-label={`Stage ${stage + 1} of 6: ${STAGES[stage]}`}>
      {STAGES.map((name, index) => <div key={name} role="listitem" className={index < stage ? 'is-done' : index === stage ? 'is-here' : undefined}>
        <i aria-hidden="true" />{name}{index < stage ? <span className="sr-only"> (done)</span> : index === stage ? <span className="sr-only"> (current)</span> : null}</div>)}
    </div>
    <section className="ck-grid">
      <div className="ck-stack">
        <div className="ck-card">
          <div className="ck-card-head"><h2>Assessment</h2><strong className={rec.tone}>{rec.label}{assessment ? ' · saved by your assistant' : ''}</strong></div>
          {assessment ? <div className="ck-divided">
            {(assessment.reasons ?? []).map((reason: any, index: number) => <div className="ck-reason" key={index}>
              <strong>{reason.text}</strong>{reason.evidence && <blockquote>“{reason.evidence}”</blockquote>}</div>)}
            {(assessment.uncertainties ?? []).length > 0 && <div className="ck-reason"><span className="ck-label t-warn">Uncertain</span>
              <span className="ck-muted">{assessment.uncertainties.join(' ')}</span></div>}
          </div> : <p className="ck-muted" style={{ margin: 0 }}>No assessment yet. Ask your assistant to assess this job; it saves reasons with quoted evidence.</p>}
          {!bound && <details>
            <summary>Assess here with your own API key</summary>
            <p>Uses only your approved claims. Needs a provider and API key in Settings. Monthly estimate: ${String(data.usage?.estimatedUsd ?? 0)} of ${String(data.usage?.budgetUsd ?? 8.5)}.</p>
            <button className="ck-btn" disabled={busy} onClick={() => void run('draft.assess', [leadId], false)}>Assess and prepare draft</button>
          </details>}
        </div>
        <form className="ck-card" onSubmit={(event) => { event.preventDefault(); const f = event.currentTarget;
          const { stage: _stage, ...current } = leadUpdate(row, { decision: field(f, 'decision'), notes: field(f, 'notes') });
          void run('leads.update', [{ ...current, ...(field(f, 'stage') ? { stage: field(f, 'stage') } : {}) }]); }}>
          <h2>Your decision</h2>
          <div className="jobsFormGrid">
            <label>Decision<select name="decision" defaultValue={row.decision}>
              {Object.entries(decisionLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Stage<select name="stage" defaultValue={row.applicationStage ?? ''}><option value="">No stage</option>
              {['researching', 'preparing', 'applied', 'interviewing', 'offer', 'closed'].map((value) => <option key={value}>{value}</option>)}</select></label>
          </div>
          <label>Notes<textarea name="notes" maxLength={4000} defaultValue={row.notes ?? ''} /></label>
          <button className="ck-btn" disabled={busy} style={{ alignSelf: 'flex-start' }}>Save lead review</button>
        </form>
        <div className="ck-card">
          <h2>Original posting</h2>
          {lead.postingText ? <p className="ck-posting" tabIndex={0} aria-label="Saved posting text"><Highlighted text={String(lead.postingText)} quotes={quotes} /></p>
            : <p className="ck-muted" style={{ margin: 0 }}>No verified posting saved yet.</p>}
          {lead.postingSourceNote && <span className="ck-faint" style={{ fontSize: '.9375rem' }}>{lead.postingSourceNote}{quotes.length ? ' · highlights are quoted evidence' : ''}</span>}
          <details open={!lead.postingText}>
            <summary>{lead.postingText ? 'Replace the saved posting' : 'Paste the original posting'}</summary>
            <form onSubmit={(event) => { event.preventDefault(); const f = event.currentTarget; void run('draft.posting', [leadId, field(f, 'posting'), field(f, 'source')]); }}>
              <label>Posting text<textarea name="posting" rows={8} required minLength={200} maxLength={30000} defaultValue={lead.postingText} /></label>
              <label>Source note<input name="source" required minLength={8} maxLength={500} defaultValue={lead.postingSourceNote} /></label>
              <button className="ck-btn" disabled={busy}>Save verified posting</button>
            </form>
          </details>
        </div>
      </div>

      <div className="ck-card">
        <div className="ck-card-head"><h2>Prepared materials</h2>
          {draft && <div className="ck-segmented" role="group" aria-label="Preview">
            {([['resume', 'Résumé'], ['packet', 'Review packet'], ['outreach', 'Outreach']] as const).map(([id, label]) =>
              <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}
          </div>}
        </div>
        {!draft && !material && <p className="ck-muted" style={{ margin: 0 }}>Ask your assistant to assess this job and select approved claim IDs. The harness assembles the documents without rewriting your experience.</p>}
        {data.workflow.stages.slice(0, 4).filter((item: any) => item.error).map((item: any) => <p key={item.id} role="status" className="t-warn" style={{ margin: 0 }}>
          {item.stage === 'assessment' ? 'Search assessment' : 'Claim selection'}: {labels[item.state]} — {item.error}</p>)}
        {draft && <div className="ck-paper">
          <div className="ck-paper-head"><strong>{tab === 'resume' ? 'Employer résumé' : tab === 'outreach' ? 'Outreach draft' : 'Private review packet'}</strong>
            <span>{tab === 'packet' ? 'Not for the employer' : 'Exact approved wording'}</span></div>
          {paper !== null ? <pre tabIndex={0} aria-label="Document preview">{paper || 'Nothing in this section.'}</pre> : <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
            {draft.truthSnapshot.map((claim: any) => <li key={claim.id}>{claim.claim} <span style={{ color: '#3d4150', fontSize: '.9375rem' }}>· {claim.id} · {claim.sourceNote}</span></li>)}
          </ul>}
        </div>}
        {material && <>
          <div className="ck-artifacts">{material.artifacts.map((artifact: any) =>
            <a key={artifact.id} className="ck-btn ck-btn--small" href={artifact.url}>{artifactName[artifact.kind] ?? 'Document'} (PDF)</a>)}</div>
          <dl className="ck-checks">
            {([['Content', material.validation.content], ['Page bounds', material.validation.bounds], ['Rendered review', material.validation.visual]] as const).map(([label, state]) =>
              <div key={label}><dt>{label}</dt><dd className={tone(state)}>{labels[state ?? ''] || 'Pending'}</dd></div>)}
          </dl>
          {material.error && <p role="status" style={{ margin: 0 }}>{material.error}</p>}
          {material.state === 'current' && !reviewed && <form className="ck-stack" style={{ gap: '.6rem' }} onSubmit={(event) => { event.preventDefault();
            void run('workflow.review', [{ id: material.id, inputHash: material.input_hash, passed: true, note: 'User inspected every rendered page, text, spacing, and links in the exported documents.' }]); }}>
            <label className="ck-confirm"><input type="checkbox" className="ck-check" required />I opened every exported page and checked the text, links, spacing, and clipping.</label>
            <button className="ck-btn" disabled={busy} style={{ alignSelf: 'flex-start' }}>Record rendered review</button>
          </form>}
          {material.state === 'needs_attention' && material.attempts < 2 && <button className="ck-btn" disabled={busy} onClick={() => void run('workflow.build', [{ leadId, repair: true }])}>Try one targeted rebuild</button>}
        </>}
        {draft && <div className="ck-row">
          <button className={`ck-btn${canApprove ? ' ck-btn--primary' : ''}`} disabled={busy || !canApprove}
            onClick={() => void run('draft.approve', [leadId, data.approval.version])}>{approved ? 'Draft approved' : 'Approve this draft'}</button>
          <span className="ck-muted" style={{ fontSize: '1rem' }}>{bound && !reviewed ? 'Record your rendered review first. ' : ''}Rendered review does not approve an employer submission.</span>
        </div>}
        {!draft && material && <p className="ck-muted" style={{ margin: 0 }}>Rendered review does not approve an employer submission.</p>}
        <details>
          <summary>More material actions</summary>
          <div className="ck-stack" style={{ marginTop: '.75rem' }}>
            <button className="ck-btn" disabled={busy} onClick={() => void run('workflow.build', [{ leadId }])}>Build saved claim selection</button>
            {draft && !bound && <>
              <button className="ck-btn" disabled={busy} onClick={rpcDownload}>Download review packet</button>
              <form onSubmit={(event) => { event.preventDefault(); const f = event.currentTarget; void run('draft.edit', [leadId, field(f, 'resume'), field(f, 'outreach')]); }}>
                <label>Résumé variant<textarea name="resume" rows={9} maxLength={12000} defaultValue={draft.resumeVariant} /></label>
                <label>Outreach<textarea name="outreach" rows={6} maxLength={3000} defaultValue={draft.outreach} /></label>
                <button className="ck-btn" disabled={busy}>Save edits for review</button>
              </form>
            </>}
            {draft && bound && <p className="ck-muted" style={{ margin: 0 }}>These materials use exact approved claims. Ask your assistant to change the selection or ordering. To change a claim’s wording, review it in Résumé truths first.</p>}
          </div>
        </details>
      </div>
    </section>
  </>;
}
