'use client';
import { useState } from 'react';
import Link from 'next/link';

type Claim = { id: string; claim: string; sourceNote: string; reviewStatus: string };
type Lead = { id: string; sourceUrl: string; verificationStatus: string; postingText: string; postingSourceNote: string };
type Props = { lead: Lead; history: { assessments: Array<{ id: number; status: string; assessment: any; createdAt: string }>; draft: any }; usage: any; claims: Claim[] };
const field: React.CSSProperties = { display: 'block', width: '100%', minHeight: 54, padding: '0.65rem', font: 'inherit', background: '#10101a', color: '#fff', border: '2px solid #aaaabd', borderRadius: 8, margin: '0.4rem 0 1rem' };
const button: React.CSSProperties = { minHeight: 56, padding: '0.6rem 1rem', font: 'inherit', fontWeight: 700, border: '3px solid #fff', borderRadius: 8, cursor: 'pointer' };

export default function DraftingPanel({ lead, history, usage, claims }: Props) {
  const [posting, setPosting] = useState(lead.postingText);
  const [note, setNote] = useState(lead.postingSourceNote);
  const [resume, setResume] = useState(history.draft?.resumeVariant ?? '');
  const [outreach, setOutreach] = useState(history.draft?.outreach ?? '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const reviewed = claims.filter((claim) => claim.reviewStatus === 'reviewed');
  const send = async (action: string) => {
    setBusy(true); setMessage('Saving…');
    try {
      const response = await fetch('/api/jobs/drafting', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, leadId: lead.id, postingText: posting, sourceNote: note, resumeVariant: resume, outreach }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Request failed.');
      setMessage(data.blocked ? data.reason : action === 'assess' ? 'Fit assessment and draft saved. Review before using.' : 'Saved.');
      if (action === 'assess') location.reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Request failed.'); }
    finally { setBusy(false); }
  };
  const query = `?leadId=${encodeURIComponent(lead.id)}`;
  return <>
    <section className="jobsPanel" style={{ marginBottom: '1rem' }} aria-labelledby="original-posting"><h2 id="original-posting">Original posting source</h2>
      <p>Paste text from the original posting you opened and state where it came from. This is your attestation; the workspace does not independently verify the pasted content. Search snippets cannot be used as posting text.</p>
      <label>Original posting text<textarea value={posting} onChange={(event) => setPosting(event.target.value)} rows={10} maxLength={30000} style={field} /></label>
      <label>Source note<input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="Opened company careers page on YYYY-MM-DD" style={field} /></label>
      <button type="button" disabled={busy} style={button} onClick={() => send('source')}>Save original posting text</button>
    </section>
    <section className="jobsPanel" style={{ marginBottom: '1rem' }} aria-labelledby="fit-assessment"><h2 id="fit-assessment">Fit assessment and draft</h2>
      <p>Uses model gpt-6-luna and reviewed claims only. Drafts require your review; nothing is sent or applied.</p>
      <p>Monthly estimated AI use: ${Number(usage.estimatedUsd ?? 0).toFixed(4)} of ${Number(usage.budgetUsd ?? 8.5).toFixed(2)} · {Number(usage.inputTokens ?? 0)} input tokens · {Number(usage.outputTokens ?? 0)} output tokens · {Number(usage.unknownCostRequests ?? 0)} requests with unknown cost.</p>
      <p>{reviewed.length} reviewed resume claims available.</p>
      {reviewed.length === 0 ? <p role="status"><strong>Blocked:</strong> Mark at least one sourced claim as reviewed in <Link href="/jobs/truths">Résumé truths</Link>.</p> : null}
      <button type="button" disabled={busy || reviewed.length === 0} style={button} onClick={() => send('assess')}>Assess fit and draft application materials</button>
      {message ? <p role="status" aria-live="polite">{message}</p> : null}
    </section>
    {history.assessments.map((item) => <section className="jobsPanel" style={{ marginBottom: '1rem' }} key={item.id} aria-label={`Assessment ${item.id}`}><h2>Assessment · {new Date(item.createdAt).toLocaleString()}</h2>
      {item.status === 'blocked' ? <p role="status"><strong>Blocked:</strong> {String(item.assessment.reason)}</p> : <>
        <p>{String(item.assessment.fitSummary ?? '')}</p>
        <h3>Strengths supported by reviewed claims</h3><ul>{(item.assessment.strengths ?? []).map((strength: any, index: number) => <li key={index}>{String(strength.text)} {strength.claimIds?.map((id: string) => <span key={id}> · <a href={`#claim-${encodeURIComponent(id)}`}>Claim {id}</a></span>)}</li>)}</ul>
        <h3>Gaps to consider</h3><ul>{(item.assessment.gaps ?? []).map((gap: string, index: number) => <li key={index}>{gap}</li>)}</ul>
      </>}
    </section>)}
    {history.draft ? <section className="jobsPanel" aria-labelledby="editable-draft"><h2 id="editable-draft">Editable application draft</h2>
      <p>Any edits you make need a claim-by-claim check against the saved truth snapshot before use. The PDF includes this snapshot for review.</p>
      <label>Resume variant<textarea value={resume} onChange={(event) => setResume(event.target.value)} rows={12} maxLength={12000} style={field} /></label>
      <label>Short outreach<textarea value={outreach} onChange={(event) => setOutreach(event.target.value)} rows={5} maxLength={3000} style={field} /></label>
      <h3>Truth snapshot used</h3><ul>{(history.draft.truthSnapshot ?? []).map((claim: Claim) => <li id={`claim-${encodeURIComponent(claim.id)}`} key={claim.id}><strong>{claim.claim}</strong> · {claim.sourceNote} · <Link href="/jobs/truths">Claim {claim.id}</Link></li>)}</ul>
      <p>Job source: <a href={lead.sourceUrl}>{lead.sourceUrl}</a></p>
      <button type="button" disabled={busy} style={button} onClick={() => send('edit')}>Save draft edits</button>
      <a href={`/api/jobs/drafting/pdf${query}`} style={{ display: 'inline-block', margin: '1rem', fontSize: '1.1rem' }}>Download selectable text PDF</a>
    </section> : null}
  </>;
}
