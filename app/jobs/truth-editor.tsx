'use client';
import { useMemo, useState } from 'react';

type Claim = { id: string; claim: string; sourceNote: string; reviewStatus: 'unreviewed' | 'reviewed' | 'rejected'; updatedAt?: string };
type Version = { createdAt: string; reviewStatus: string; claim: string; sourceNote: string };
type Filter = 'all' | Claim['reviewStatus'];
export default function TruthEditor({ claims }: { claims: Claim[] }) {
  const [items, setItems] = useState(claims);
  const [drafts, setDrafts] = useState<Record<string, Claim>>({});
  const [selectedId, setSelectedId] = useState(claims[0]?.id ?? '');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [histories, setHistories] = useState<Record<string, Version[]>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const visible = useMemo(() => items.filter((item) => (filter === 'all' || item.reviewStatus === filter) && `${item.claim} ${item.sourceNote}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [items, filter, search]);
  const selected = visible.find((item) => item.id === selectedId);
  const draft = selected ? drafts[selected.id] ?? selected : undefined;
  const updateDraft = (changes: Partial<Claim>) => { if (draft) setDrafts((current) => ({ ...current, [draft.id]: { ...draft, ...changes } })); };
  const save = async () => {
    if (!draft) return;
    setBusy(true); setMessage('Saving…');
    try {
      const response = await fetch('/api/jobs/resume-truth', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Save failed.');
      setItems((current) => current.map((item) => item.id === draft.id ? draft : item));
      setDrafts((current) => { const next = { ...current }; delete next[draft.id]; return next; });
      setHistories((current) => { const next = { ...current }; delete next[draft.id]; return next; });
      setMessage('Saved truth and recorded a new version.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Save failed.'); }
    finally { setBusy(false); }
  };
  const showHistory = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/jobs/resume-truth?id=${encodeURIComponent(draft.id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not load history.');
      setHistories((current) => ({ ...current, [draft.id]: data.versions ?? [] }));
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load history.'); }
    finally { setBusy(false); }
  };
  return <section className="jobsTruthLayout" aria-label="Résumé truth editor">
    <div className="jobsPanel"><h2>Find a truth</h2><label>Search claims and source notes<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search your evidence" /></label>
      <label>Status<select value={filter} onChange={(event) => setFilter(event.target.value as Filter)}><option value="all">All statuses</option><option value="unreviewed">Unreviewed</option><option value="reviewed">Reviewed</option><option value="rejected">Rejected</option></select></label>
      <p className="jobsMuted">{visible.length} of {items.length} truths shown</p><div className="jobsTruthList" role="list" aria-label="Résumé truths">{visible.map((item) => <div role="listitem" key={item.id}><button type="button" aria-current={selectedId === item.id ? 'true' : undefined} onClick={() => { setSelectedId(item.id); setMessage(''); }}><span className="jobsTruthStatus">{item.reviewStatus}</span>{item.claim}</button></div>)}{visible.length === 0 ? <p>No truths match this filter.</p> : null}</div>
    </div>
    <div className="jobsPanel" aria-live="off">{draft ? <><p className="jobsEyebrow">Selected truth · {draft.reviewStatus}</p><h2>Edit truth</h2><p className="jobsMuted">Only reviewed claims can support generated drafts. A save creates a new version. Public résumé text is separate.</p><p className="jobsMuted">Claim ID: {draft.id}</p>
      <label>Claim<textarea value={draft.claim} onChange={(event) => updateDraft({ claim: event.target.value })} rows={5} maxLength={4000} /></label>
      <label>Source note<textarea value={draft.sourceNote} onChange={(event) => updateDraft({ sourceNote: event.target.value })} rows={3} maxLength={1000} /></label>
      <label>Review status<select value={draft.reviewStatus} onChange={(event) => updateDraft({ reviewStatus: event.target.value as Claim['reviewStatus'] })}><option value="unreviewed">Unreviewed</option><option value="reviewed">Reviewed and approved</option><option value="rejected">Rejected</option></select></label>
      <div className="jobsActions"><button type="button" className="jobsButtonPrimary" disabled={busy} onClick={save}>Save new version</button><button type="button" disabled={busy} onClick={showHistory}>View version history</button></div>
      {message ? <p role="status" aria-live="polite">{message}</p> : null}
      {histories[draft.id] ? <div className="jobsHistory"><h3>Version history</h3><ol>{histories[draft.id].map((version, index) => <li key={`${version.createdAt}-${index}`}><time>{new Date(version.createdAt).toLocaleString()}</time> · <strong>{version.reviewStatus}</strong><p>{version.claim}</p><p>Source: {version.sourceNote}</p></li>)}</ol></div> : null}
    </> : <><h2>Select a truth</h2><p>Choose a claim from the list to review its evidence.</p></>}</div>
  </section>;
}
