import { useEffect, useRef, useState } from 'react';

export type ActivityEvent = { id: string; at: string; tool: string; method: string; ok: boolean; kind: string; summary: string;
  leadId: string | null; title: string | null; organization: string | null };
export type Lease = { itemId: string; leadId: string; title: string; organization: string; expiresAt: string; status: string };
export type LiveState = { now: string; events: ActivityEvent[]; leases: Lease[]; lastCallAt: string | null;
  counts: { leads: number; truths: number; reconcile: number; today: number } };

/** Polls the owner while the page is visible. The cockpit never needs this to work offline. */
export function useLive(load: () => Promise<LiveState>, interval = 4000) {
  const [state, setState] = useState<{ live: LiveState | null; offline: boolean; skew: number }>({ live: null, offline: false, skew: 0 });
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const live = await loader.current();
          if (!stopped) setState({ live, offline: false, skew: Date.parse(live.now) - Date.now() });
        } catch {
          if (!stopped) setState((current) => ({ ...current, offline: true }));
        }
      }
      if (!stopped) timer = setTimeout(tick, interval);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [interval]);
  return state;
}

/** Seconds-resolution clock, corrected for the owner's clock. */
export function useNow(skew = 0) {
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + skew), 1000);
    return () => clearInterval(timer);
  }, [skew]);
  return now;
}

export const leaseLeft = (expiresAt: string, now: number) => Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
export function ago(iso: string | null, now: number) {
  if (!iso) return 'never';
  const seconds = Math.max(1, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

const kinds: Record<string, [string, string]> = {
  read: ['Read', 't-muted'], saved: ['Saved', 't-ok'], lease: ['Lease', 't-accent'], collect: ['Collect', 't-warn'],
  needs_you: ['Needs you', 't-accent'], receipt: ['Receipt', 't-ok'], error: ['Rejected', 't-bad'],
};

export function ActivityFeed({ live, offline, now, onClose, overlay }: { live: LiveState | null; offline: boolean; now: number; onClose: () => void; overlay: boolean }) {
  const newest = live?.events[0];
  const fresh = newest && now - Date.parse(newest.at) < 8000;
  return <aside className="ck-feed" aria-labelledby="ck-feed-title">
    <div className="ck-feed-head">
      <div>
        <h2 id="ck-feed-title">Assistant activity</h2>
        <span className={`ck-live ${offline ? 't-bad' : 't-ok'}`}><span className="ck-dot" aria-hidden="true" />{offline ? 'Offline' : 'Live'}</span>
      </div>
      <p>Tool calls from your AI assistant over the job-search-harness MCP connection.</p>
      {overlay && <button type="button" className="ck-btn ck-btn--small ck-btn--ghost" onClick={onClose}>Close activity</button>}
    </div>
    {!live ? <p className="ck-feed-empty">Loading activity…</p> : !live.events.length
      ? <p className="ck-feed-empty">No tool calls yet. Ask your assistant to check your job search setup and its calls will appear here.</p>
      : <ol aria-live="polite" aria-relevant="additions" aria-label="Recent tool calls" tabIndex={0}>
        {live.events.map((event, index) => {
          const [label, tone] = kinds[event.kind] ?? ['Call', 't-muted'];
          return <li key={event.id} className={index === 0 && fresh ? 'is-new' : undefined}>
            <div className="ck-feed-tool"><code>{event.tool || event.method}</code><span className={`ck-tag ${tone}`}>{label}</span></div>
            <span>{event.summary}</span>
            <small><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time>
              {' · '}{event.organization || event.title || 'Workspace'}</small>
          </li>;
        })}
      </ol>}
    <p className="ck-feed-foot">The assistant cannot submit to employers. A submission needs your approved draft and the employer’s confirmation.</p>
  </aside>;
}
