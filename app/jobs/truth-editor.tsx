'use client';
import { useState } from 'react';

type Claim = { id: string; claim: string; sourceNote: string; reviewStatus: 'unreviewed' | 'reviewed' | 'rejected'; updatedAt?: string };
const field: React.CSSProperties = { display: 'block', width: '100%', minHeight: 50, font: 'inherit', color: '#fff', background: '#10101a', border: '2px solid #aaaabd', borderRadius: 8, padding: '0.55rem', marginBlock: '0.35rem 0.7rem' };
export default function TruthEditor({ claims }: { claims: Claim[] }) {
  const [items, setItems] = useState(claims);
  const [histories, setHistories] = useState<Record<string, any[]>>({});
  const [message, setMessage] = useState('');
  const save = async (claim: Claim) => {
    const response = await fetch('/api/jobs/resume-truth', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(claim) });
    const data = await response.json();
    if (!response.ok) { setMessage(data.error ?? 'Save failed.'); return; }
    setItems((current) => current.map((item) => item.id === claim.id ? claim : item));
    setMessage(`Saved ${claim.id}. A version was recorded.`);
  };
  const showHistory = async (id: string) => {
    const response = await fetch(`/api/jobs/resume-truth?id=${encodeURIComponent(id)}`);
    const data = await response.json();
    if (response.ok) setHistories((current) => ({ ...current, [id]: data.versions ?? [] }));
    else setMessage(data.error ?? 'Could not load claim history.');
  };
  return <section aria-labelledby="truth-heading" style={{ marginTop: '1.5rem' }}>
    <h2 id="truth-heading">Resume truth and source notes</h2>
    <p>Edit facts and source notes here. Mark a claim reviewed only after checking it against its source. Only reviewed claims can support generated drafts.</p>
    {message ? <p role="status" aria-live="polite">{message}</p> : null}
    <div style={{ display: 'grid', gap: '1rem' }}>{items.map((claim) => <ClaimRow key={claim.id} claim={claim} onSave={save} onHistory={showHistory} history={histories[claim.id]} />)}</div>
  </section>;
}
function ClaimRow({ claim, onSave, onHistory, history }: { claim: Claim; onSave: (claim: Claim) => void; onHistory: (id: string) => void; history?: any[] }) {
  const [draft, setDraft] = useState(claim);
  return <details style={{ border: '1px solid #aaaabd', borderRadius: 8, padding: '0.5rem' }}>
    <summary>{claim.reviewStatus.toUpperCase()} · {claim.claim.slice(0, 180)}{claim.claim.length > 180 ? '…' : ''}</summary>
    <div style={{ padding: '0.5rem' }}><p><strong>Claim ID:</strong> {claim.id}</p>
    <label>Claim<textarea value={draft.claim} onChange={(event) => setDraft({ ...draft, claim: event.target.value })} rows={3} maxLength={4000} style={field} /></label>
    <label>Source note<textarea value={draft.sourceNote} onChange={(event) => setDraft({ ...draft, sourceNote: event.target.value })} rows={2} maxLength={1000} style={field} /></label>
    <label>Review status<select value={draft.reviewStatus} onChange={(event) => setDraft({ ...draft, reviewStatus: event.target.value as Claim['reviewStatus'] })} style={field}><option value="unreviewed">Unreviewed</option><option value="reviewed">Reviewed and approved</option><option value="rejected">Rejected</option></select></label>
    <button type="button" onClick={() => onSave(draft)} style={{ minHeight: 48, font: 'inherit', fontWeight: 700 }}>Save claim and record version</button>{' '}
    <button type="button" onClick={() => onHistory(claim.id)} style={{ minHeight: 48, font: 'inherit', fontWeight: 700 }}>Show version history</button>
    {history ? <ol aria-label={`Version history for ${claim.id}`}>{history.map((version) => <li key={`${version.createdAt}-${version.reviewStatus}`}><time>{new Date(version.createdAt).toLocaleString()}</time> · <strong>{version.reviewStatus}</strong><p>{version.claim}</p><p>Source: {version.sourceNote}</p></li>)}</ol> : null}
    </div>
  </details>;
}
