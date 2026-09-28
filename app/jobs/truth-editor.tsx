'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { editedStatus, groupTruths, relatedTruthPairs, truthProgress, truthSections, type ReviewClaim, type TruthChange, type TruthStatus } from '@/lib/resume-truth-review';

type Version = { createdAt: string; reviewStatus: string; claim: string; sourceNote: string };
type Draft = { claim: string; sourceNote: string };
const statusLabels = { unreviewed: 'Unreviewed', reviewed: 'Reviewed', rejected: 'Rejected' };

function TruthRow({ item, selected, busy, editing, draft, onSelect, onEdit, onDraft, onSave, onCancel, showSources, children }: {
  item: ReviewClaim; selected: boolean; busy: boolean; editing: boolean; draft: Draft | null;
  onSelect: () => void; onEdit: () => void; onDraft: (draft: Draft) => void;
  showSources: boolean; onSave: (status: TruthStatus) => void; onCancel: () => void; children?: React.ReactNode;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  async function history() {
    setLoading(true); setHistoryError('');
    try {
      const response = await fetch(`/api/jobs/resume-truth?id=${encodeURIComponent(item.id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not load history.');
      setVersions(data.versions);
    } catch (error) { setHistoryError(error instanceof Error ? error.message : 'Could not load history.'); }
    finally { setLoading(false); }
  }
  return <li className="truthRow" data-truth-id={item.id}>
    <div className="truthRowMain">
      {item.reviewStatus === 'unreviewed' ? <label className="truthChoice"><input type="checkbox" checked={selected} disabled={busy || editing} onChange={onSelect} /><span>{item.claim}</span></label> : <p className="truthSavedClaim">{item.claim}</p>}
      <span className="truthSavedStatus">{statusLabels[item.reviewStatus]}</span>
      <button type="button" onClick={onEdit} disabled={busy || editing} aria-label={`Edit: ${item.claim}`}>Edit</button>
    </div>
    <details className="truthSource" hidden={!showSources && !editing}><summary>Source and history</summary><p>{item.sourceNote}</p><p className="jobsMuted">Claim ID: {item.id}</p>
      <button type="button" onClick={history} disabled={loading}>{loading ? 'Loading history…' : 'View version history'}</button>
      {historyError && <p role="alert">{historyError}</p>}
      {versions && <ol className="jobsHistory">{versions.map((version, index) => <li key={index}><strong>{statusLabels[version.reviewStatus as TruthStatus] ?? version.reviewStatus}</strong> · <time>{new Date(version.createdAt).toLocaleString()}</time><p>{version.claim}</p><p>Source: {version.sourceNote}</p></li>)}</ol>}
    </details>
    {editing && draft && <form className="truthEdit" onSubmit={(event) => { event.preventDefault(); onSave(editedStatus(item, draft)); }}>
      <h3>Edit truth</h3><p>Saved status: {statusLabels[item.reviewStatus]}. Changes stay unsaved until you choose a save action.</p>
      <label>Claim<textarea ref={input} required maxLength={4000} rows={4} value={draft.claim} onChange={(event) => onDraft({ ...draft, claim: event.target.value })} disabled={busy} /></label>
      <label>Source note<textarea required maxLength={1000} rows={3} value={draft.sourceNote} onChange={(event) => onDraft({ ...draft, sourceNote: event.target.value })} disabled={busy} /></label>
      {item.reviewStatus === 'reviewed' && <p>Saving changed wording or a changed source without approval returns this truth to unreviewed.</p>}
      <div className="truthEditActions"><button type="submit" disabled={busy}>Save changes</button><button type="button" className="jobsButtonPrimary" disabled={busy || !draft.claim.trim() || !draft.sourceNote.trim()} onClick={() => onSave('reviewed')}>Save &amp; approve</button><button type="button" disabled={busy || !draft.claim.trim() || !draft.sourceNote.trim()} onClick={() => onSave('rejected')}>Reject</button><button type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>
    </form>}
    {children}
  </li>;
}

export default function TruthEditor({ claims }: { claims: ReviewClaim[] }) {
  const [items, setItems] = useState(claims);
  const groups = useMemo(() => groupTruths(items), [items]);
  const [activeId, setActiveId] = useState(() => groupTruths(claims).find((g) => g.claims.some((c) => c.reviewStatus === 'unreviewed'))?.id ?? groupTruths(claims)[0]?.id ?? '');
  const active = groups.find((g) => g.id === activeId) ?? groups[0];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showSources, setShowSources] = useState(false);
  const [filter, setFilter] = useState<'all' | TruthStatus>('all');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [undo, setUndo] = useState<TruthChange[] | null>(null);
  const [retry, setRetry] = useState<{ changes: TruthChange[]; approval: boolean; undoing: boolean } | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const allCheckbox = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const pairs = useMemo(() => relatedTruthPairs(items), [items]);
  const pairedCopies = new Set(pairs.values());
  const matches = (item: ReviewClaim) => (filter === 'all' || item.reviewStatus === filter) && `${item.claim} ${item.sourceNote}`.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  const filtering = filter !== 'all' || search.trim().length > 0;
  const roots = (active?.claims ?? []).filter((item) => filtering ? matches(item) : !pairedCopies.has(item.id));
  const visible = roots.flatMap((item) => [item, ...(!filtering && expanded.has(item.id) ? active?.claims.filter((copy) => copy.id === pairs.get(item.id)) ?? [] : [])]);
  const selectable = visible.filter((item) => item.reviewStatus === 'unreviewed');
  const selectedItems = items.filter((item) => selected.has(item.id));
  const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.id));
  const progress = truthProgress(items);
  const locked = busy || editingId !== null;
  useEffect(() => { if (allCheckbox.current) allCheckbox.current.indeterminate = !allSelected && selectable.some((item) => selected.has(item.id)); });
  useEffect(() => {
    if (!draft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const keepEdit = (event: MouseEvent) => {
      if ((event.target as Element).closest('a[href]')) {
        event.preventDefault(); event.stopPropagation();
        setMessage('Save or cancel your edit before leaving this page.');
      }
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', keepEdit, true);
    return () => { window.removeEventListener('beforeunload', warn); document.removeEventListener('click', keepEdit, true); };
  }, [draft]);

  const previousGroup = useRef(activeId);
  useLayoutEffect(() => {
    if (previousGroup.current !== activeId) { heading.current?.focus(); previousGroup.current = activeId; }
  }, [activeId]);
  useLayoutEffect(() => {
    if (message && message !== 'Saving…') status.current?.focus();
  }, [message]);

  function selectGroup(id: string) {
    setActiveId(id); setSelected(new Set()); setExpanded(new Set()); setSearch(''); setFilter('all'); setMessage(''); setError(''); setConflicts([]); setRetry(null);
  }
  function toggle(id: string) {
    setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    setRetry(null);
  }
  function closeEdit() {
    const id = editingId;
    setEditingId(null); setDraft(null); setRetry(null);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-truth-id="${CSS.escape(id ?? '')}"] .truthRowMain button`)?.focus());
  }
  async function save(changes: TruthChange[], approval = false, undoing = false) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setMessage('Saving…'); setConflicts([]);
    const previous = items;
    try {
      const response = await fetch('/api/jobs/resume-truth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }) });
      const data = await response.json();
      if (!response.ok) { setConflicts(data.conflicts ?? []); throw new Error(data.error ?? 'Save failed. Your selection and edits are still here.'); }
      setItems(data.claims); setSelected(new Set()); setEditingId(null); setDraft(null); setRetry(null);
      if (approval) setUndo((data.updated as ReviewClaim[]).map((item) => {
        const before = previous.find((claim) => claim.id === item.id)!;
        return { id: item.id, expectedVersion: item.version, reviewStatus: editedStatus(before, item) };
      }));
      else if (undoing || undo?.some((change) => changes.some((saved) => change.id === saved.id))) setUndo(null);
      setMessage(undoing ? 'Approval undone. A new version was recorded.' : `${changes.length} ${changes.length === 1 ? 'truth' : 'truths'} ${approval ? 'approved' : 'saved'}. Progress saved. A new version was recorded for each truth.`);
    } catch (failure) {
      setMessage(''); setError(failure instanceof Error ? failure.message : 'Save failed.'); setRetry({ changes, approval, undoing });
    } finally { inFlight.current = false; setBusy(false); }
  }
  async function refresh() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/jobs/resume-truth'); const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not refresh truths.');
      setItems(data.claims); setConflicts([]); setRetry(null);
      setSelected((current) => new Set((data.claims as ReviewClaim[]).filter((item) => current.has(item.id) && item.reviewStatus === 'unreviewed').map((item) => item.id)));
      setMessage(draft ? 'Saved facts refreshed. Your unsaved edit is retained below the latest saved wording. Compare both before saving again.' : 'Saved facts refreshed. Review the selected wording before approving again.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Refresh failed.'); }
    finally { setBusy(false); }
  }
  function renderRow(item: ReviewClaim, related = false) {
    const copy = items.find((claim) => claim.id === pairs.get(item.id));
    return <TruthRow key={`${item.id}:${item.version}`} item={item} showSources={showSources || related} selected={selected.has(item.id)} busy={busy || (editingId !== null && editingId !== item.id)} editing={editingId === item.id} draft={editingId === item.id ? draft : null}
      onSelect={() => toggle(item.id)} onEdit={() => { setEditingId(item.id); setDraft({ claim: item.claim, sourceNote: item.sourceNote }); setRetry(null); }} onDraft={(value) => { setDraft(value); setRetry(null); }}
      onCancel={closeEdit} onSave={(reviewStatus) => { if (draft) void save([{ id: item.id, expectedVersion: item.version, ...draft, reviewStatus }], reviewStatus === 'reviewed'); }}>
      {!filtering && !related && copy && <div className="truthComparison"><button type="button" aria-expanded={expanded.has(item.id)} disabled={locked} onClick={() => {
        const closing = expanded.has(item.id);
        setExpanded((current) => { const next = new Set(current); if (closing) next.delete(item.id); else next.add(item.id); return next; });
        if (closing) setSelected((selection) => { const next = new Set(selection); next.delete(copy.id); return next; });
      }}>{expanded.has(item.id) ? 'Hide related wording' : 'Compare related wording'} · {statusLabels[copy.reviewStatus]}</button>
        {expanded.has(item.id) && <div className="truthCompareBody"><h3>Related accomplishment</h3><p>Each wording has its own source and approval. Select only the facts you have checked.</p><p>Role source: {item.sourceNote}</p><p>Accomplishment source: {copy.sourceNote}</p><ul className="truthRows">{renderRow(copy, true)}</ul></div>}
      </div>}
    </TruthRow>;
  }

  return <section className="truthReview" aria-label="Résumé truth review">
    <header className="truthHeader"><div><h1>Résumé truths</h1><p>Private · Approval supports drafts. Your public résumé stays separate.</p></div><p className="truthProgress"><strong>{progress.reviewed}</strong> reviewed · <strong>{progress.unreviewed}</strong> unreviewed · <strong>{progress.rejected}</strong> rejected</p></header>
    <div className="truthFeedback"><p ref={status} tabIndex={-1} role="status" aria-live="polite">{message}</p>
      {error && <div role="alert"><p>{error}</p>{conflicts.length > 0 && <ul>{conflicts.map((id) => <li key={id}>{items.find((item) => item.id === id)?.claim ?? id}</li>)}</ul>}
        {retry && !conflicts.length && <button type="button" disabled={busy} onClick={() => save(retry.changes, retry.approval, retry.undoing)}>Retry save</button>}{' '}<button type="button" disabled={busy} onClick={refresh}>Refresh saved truths</button></div>}
      {undo && <button type="button" disabled={locked} onClick={() => save(undo, false, true)}>Undo last approval</button>}
    </div>
    <div className="truthLayout"><nav className="truthSections" aria-label="Truth sections">{truthSections.map((section) => {
      const sectionGroups = groups.filter((group) => group.section === section);
      return <button key={section} type="button" aria-current={active?.section === section ? 'true' : undefined} disabled={locked || !sectionGroups.length} onClick={() => selectGroup(sectionGroups.find((group) => group.claims.some((item) => item.reviewStatus === 'unreviewed'))?.id ?? sectionGroups[0].id)}>{section}</button>;
    })}</nav>
    <div className="truthGroup">{active ? <>
      <div className="truthGroupHeader"><h2 ref={heading} tabIndex={-1}>{active.label}</h2><p>Review these facts together.</p>

        <div className="truthGroupTools"><div className="truthSourceControl"><span>Sources: your résumé and saved notes</span><button type="button" aria-expanded={showSources} onClick={() => setShowSources(!showSources)}>{showSources ? 'Hide source notes' : 'View source notes'}</button></div>
        <details className="truthFilters"><summary>Choose role or filter</summary>{active.section === 'Work experience' && <label className="truthRolePicker">Role<select value={active.id} disabled={locked} onChange={(event) => selectGroup(event.target.value)}>{groups.filter((group) => group.section === 'Work experience').map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}</select></label>}<div><label>Search this group<input type="search" value={search} disabled={locked} onChange={(event) => { setSearch(event.target.value); setSelected(new Set()); setRetry(null); }} /></label><label>Status<select value={filter} disabled={locked} onChange={(event) => { setFilter(event.target.value as typeof filter); setSelected(new Set()); setRetry(null); }}><option value="all">All statuses</option><option value="unreviewed">Unreviewed</option><option value="reviewed">Reviewed</option><option value="rejected">Rejected</option></select></label></div></details></div>
        <p>Selection alone does not approve a fact.</p>
        <label className="truthSelectAll"><input ref={allCheckbox} type="checkbox" checked={allSelected} disabled={locked || !selectable.length} onChange={() => { setSelected(allSelected ? new Set() : new Set(selectable.map((item) => item.id))); setRetry(null); }} /><span>Select all {selectable.length} visible unreviewed facts</span></label>
      </div>
      <ul className="truthRows">{roots.map((item) => renderRow(item))}</ul>
      {!roots.length && <p className="truthEmpty">No truths match this filter.</p>}
      {!active.claims.some((item) => item.reviewStatus === 'unreviewed') && <p className="truthEmpty">No unreviewed facts remain in this group. You can revisit any fact or continue to the next group.</p>}
      <footer className="truthActions"><p>{selected.size} selected · {active.claims.filter((item) => item.reviewStatus === 'unreviewed' && !selected.has(item.id)).length} left for later</p>
        <button type="button" className="jobsButtonPrimary" disabled={locked || selected.size === 0 || !!conflicts.length} onClick={() => save(selectedItems.map((item) => ({ id: item.id, expectedVersion: item.version, reviewStatus: 'reviewed' })), true)}>{busy ? 'Saving…' : `Approve ${selected.size} selected`}</button>
        <button type="button" disabled={locked || groups.indexOf(active) === groups.length - 1} onClick={() => selectGroup(groups[groups.indexOf(active) + 1].id)}>{active.section === 'Work experience' && groups[groups.indexOf(active) + 1]?.section === 'Work experience' ? 'Next role' : 'Next group'}</button>
        <Link href="/jobs" aria-disabled={locked || undefined} onClick={(event) => { if (locked) event.preventDefault(); }}>Finish for now</Link>
      </footer>
    </> : <p className="truthEmpty">No résumé truths yet.</p>}</div></div>
  </section>;
}
