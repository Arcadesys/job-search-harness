import type { Method } from '../contract';

/** reload: true reloads the page, a path navigates there, false shows the result. */
export type Run = (method: Method, args?: unknown[], reload?: boolean | string) => Promise<void>;
export type Tone = 't-ok' | 't-warn' | 't-bad' | 't-accent' | 't-muted';
export const STAGES = ['Discovered', 'Assessed', 'Chosen', 'Materials', 'Approved', 'Submitted'];

/** One row of cockpit.pipeline. */
export type PipelineJob = {
  id: string; title: string; organization: string; location: string; source: string; verificationStatus: string; decision: string;
  applicationStage: string | null; itemId: string | null; itemStatus: string | null; leaseExpiresAt: string | null; leased: boolean;
  draftStatus: string | null; hasDraft: boolean; recommendation: string | null; selectionState: string | null; materialState: string | null;
  validation: { content?: string; bounds?: string; visual?: string } | null; receiptAt: string | null; stage: number;
};
export type Pipeline = { stages: string[]; jobs: PipelineJob[]; funnel: { leads: number; assessed: number; chosen: number; approved: number; receipts: number } };

const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

/** The single most useful status for a role, always as words plus a tone. */
export function jobStatus(job: PipelineJob): { label: string; tone: Tone } {
  if (job.receiptAt) return { label: `Receipt ${shortDate(job.receiptAt)}`, tone: 't-ok' };
  if (job.applicationStage && ['applied', 'interviewing', 'offer'].includes(job.applicationStage)) return { label: job.applicationStage === 'applied' ? 'Applied' : job.applicationStage === 'offer' ? 'Offer' : 'Interviewing', tone: 't-ok' };
  if (job.itemStatus === 'blocked') return { label: 'Blocked', tone: 't-bad' };
  if (job.leased) return { label: 'Assistant preparing', tone: 't-accent' };
  if (job.draftStatus === 'approved') return { label: 'Approved', tone: 't-ok' };
  if (job.materialState === 'needs_attention') return { label: 'Needs attention', tone: 't-warn' };
  if (job.materialState === 'current' && job.validation?.visual !== 'passed') return { label: 'Rendered review', tone: 't-accent' };
  if (job.itemStatus === 'awaiting_approval' || (job.materialState === 'current' && job.draftStatus !== 'approved')) return { label: 'Awaiting you', tone: 't-accent' };
  if (job.itemStatus === 'queued') return { label: 'Queued', tone: 't-muted' };
  if (job.itemStatus === 'preparing') return { label: 'Preparing', tone: 't-accent' };
  if (job.itemStatus === 'skipped') return { label: 'Skipped', tone: 't-muted' };
  if (job.decision === 'keep') return { label: 'Ready to queue', tone: 't-muted' };
  if (job.recommendation === 'candidate') return { label: 'Candidate', tone: 't-ok' };
  if (job.recommendation === 'uncertain') return { label: 'Uncertain fit', tone: 't-warn' };
  if (job.recommendation === 'exclude') return { label: 'Exclude suggested', tone: 't-bad' };
  if (job.verificationStatus === 'unverified') return { label: 'Unverified', tone: 't-muted' };
  return { label: 'To review', tone: 't-muted' };
}

export const recommendationLabel = (value: string | null | undefined): { label: string; tone: Tone } =>
  value === 'candidate' ? { label: 'Candidate', tone: 't-ok' } : value === 'uncertain' ? { label: 'Uncertain', tone: 't-warn' }
    : value === 'exclude' ? { label: 'Exclude', tone: 't-bad' } : { label: 'Not assessed', tone: 't-muted' };
export const verificationLabel = (value: string): { label: string; tone: Tone } =>
  value === 'verified' ? { label: 'Verified', tone: 't-ok' } : value === 'stale' ? { label: 'Stale', tone: 't-warn' }
    : value === 'unavailable' ? { label: 'Unavailable', tone: 't-bad' } : { label: 'Unverified', tone: 't-muted' };
export const decisionLabel: Record<string, string> = { review: 'Review', keep: 'Pursue', pass: 'Pass' };

export const Status = ({ label, tone }: { label: string; tone: Tone }) =>
  <span className={`ck-status ${tone}`}><span className="ck-dot" aria-hidden="true" /><span className="t-text">{label}</span></span>;

export function PageHead({ title, description, kicker, kickerTone, children }: { title: string; description?: React.ReactNode; kicker?: string; kickerTone?: Tone; children?: React.ReactNode }) {
  return <header className="ck-head">
    <div>
      {kicker && <span className={`ck-kicker${kickerTone ? ` ${kickerTone}` : ''}`}>{kicker}</span>}
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </div>
    {children && <div className="ck-row">{children}</div>}
  </header>;
}
