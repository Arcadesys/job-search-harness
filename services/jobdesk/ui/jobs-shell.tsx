import { useEffect, useState } from 'react';
import { ActivityFeed, ago, type LiveState } from './live';

export type View = 'today' | 'leads' | 'truths' | 'review' | 'settings' | 'workflow' | 'excluded' | 'reconcile';
type Count = keyof LiveState['counts'];
const navigation: { id: View; label: string; href: string; count?: Count; tone?: 'accent' | 'bad' }[] = [
  { id: 'today', label: 'Today', href: '/jobs', count: 'today', tone: 'accent' },
  { id: 'leads', label: 'Leads', href: '/jobs/leads', count: 'leads' },
  { id: 'workflow', label: 'Discovery and preparation', href: '/jobs/workflow' },
  { id: 'excluded', label: 'Excluded jobs', href: '/jobs/excluded' },
  { id: 'truths', label: 'Résumé truths', href: '/jobs/truths', count: 'truths', tone: 'accent' },
  { id: 'review', label: 'Weekly review', href: '/jobs/review' },
  { id: 'reconcile', label: 'Reconciliation', href: '/jobs/reconcile', count: 'reconcile', tone: 'bad' },
  { id: 'settings', label: 'Settings', href: '/jobs/settings' },
];
const FEED_KEY = 'jobdesk.feed';
const readPreference = () => { try { return localStorage.getItem(FEED_KEY); } catch { return null; } };
/** Dock the feed only with room for 80rem, so large text settings keep the main column usable. */
function useWide() {
  const measure = () => typeof window !== 'undefined' &&
    innerWidth >= 80 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
  const [wide, setWide] = useState(measure);
  useEffect(() => {
    const change = () => setWide(measure());
    addEventListener('resize', change);
    return () => removeEventListener('resize', change);
  }, []);
  return wide;
}

export default function JobsShell({ active, children, truthReview = false, sessionLabel = 'Local session', crumb, live, offline = false, now = Date.now() }: {
  active: View; children: React.ReactNode; truthReview?: boolean; sessionLabel?: string; crumb?: string;
  live?: LiveState | null; offline?: boolean; now?: number;
}) {
  const wide = useWide();
  const [opened, setOpened] = useState<boolean | null>(null);
  const hasFeed = live !== undefined;
  const feedOpen = hasFeed && (opened ?? (wide && readPreference() !== 'hidden'));
  const mode = !feedOpen ? 'none' : wide ? 'docked' : 'overlay';
  const toggle = () => {
    const next = !feedOpen;
    setOpened(next);
    if (wide) try { localStorage.setItem(FEED_KEY, next ? 'shown' : 'hidden'); } catch { /* preference is optional */ }
  };
  const current = navigation.find((item) => item.id === active);
  const recent = live?.lastCallAt && now - Date.parse(live.lastCallAt) < 5 * 60 * 1000;
  return <div className={`jobsWorkspace jobsApp ck${truthReview ? ' jobsTruthApp' : ''}`} data-feed={mode}>
    <a className="jobsSkip" href="#jobs-content">Skip to content</a>
    <aside className="ck-rail" aria-label="Private job workspace navigation">
      <div className="ck-brand"><span className="ck-brand-mark" aria-hidden="true">◆</span><div><strong>Job Search Harness</strong><small>Private workspace</small></div></div>
      <nav className="ck-nav" aria-label="Job Search Harness"><ul>{navigation.map((item) => {
        const count = item.count && live?.counts[item.count];
        return <li key={item.id}><a href={item.href} aria-current={active === item.id ? 'page' : undefined} aria-describedby={count ? `ck-count-${item.id}` : undefined}>
          <span>{item.label}</span>
          {count ? <span id={`ck-count-${item.id}`} className={`ck-count${item.tone ? ` ck-count--${item.tone}` : ''}`} aria-hidden="true">{count}<span className="sr-only"> waiting</span></span> : null}
        </a></li>;
      })}</ul></nav>
      {hasFeed && <div className="ck-assistant">
        <span className="ck-label">Assistant</span>
        <strong><span className={`ck-dot ${recent ? 't-ok' : 't-muted'}`} aria-hidden="true" />{recent ? 'Working over MCP' : 'Idle'}</strong>
        <p>Last tool call {ago(live?.lastCallAt ?? null, now)}.</p>
      </div>}
      <p className="ck-rail-note">Your applications and résumé truths stay private on this computer.</p>
    </aside>
    <div className="ck-column">
      <header className="ck-topbar">
        <div className="ck-crumb"><strong>{current?.label ?? 'Job Search Harness'}</strong>{crumb && <><span aria-hidden="true">/</span><span>{crumb}</span></>}</div>
        <div className="ck-top-actions">
          {hasFeed && <span className="ck-pill ck-pill--ok"><span className={`ck-dot ${offline ? 't-bad' : 't-ok'}`} aria-hidden="true" />{offline ? 'Owner unreachable' : 'Owner running'}</span>}
          <span className="ck-pill jobsPrivateBadge">Private · {sessionLabel}</span>
          {hasFeed && <button type="button" className="ck-btn ck-btn--small ck-pill--accent" aria-expanded={feedOpen} onClick={toggle}>{feedOpen ? 'Hide activity' : 'Show activity'}</button>}
        </div>
      </header>
      <main id="jobs-content" className="ck-main jobsContent">{children}</main>
    </div>
    {feedOpen && <ActivityFeed live={live ?? null} offline={offline} now={now} overlay={mode === 'overlay'} onClose={() => setOpened(false)} />}
  </div>;
}
