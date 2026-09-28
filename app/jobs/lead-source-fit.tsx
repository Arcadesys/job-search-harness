import type { ReviewClaim } from '@/lib/resume-truth-review';
import { leadFitPreview } from '@/lib/job-lead-fit';

type Lead = { title: string; source: string; sourceUrl: string; verificationStatus: string };

export default function LeadSourceFit({ lead, claims, detail = false }: { lead: Lead; claims: ReviewClaim[]; detail?: boolean }) {
  const preview = leadFitPreview(lead, claims);
  return <div className="jobsLeadSourceFit">
    <p><strong>Posting link{preview ? ' from email' : ''}:</strong> <a className="jobsPostingLink" href={lead.sourceUrl}>{lead.sourceUrl}</a></p>
    {preview ? <section className="jobsFitPreview" aria-label="Preliminary fit explanation">
      {detail ? <h2>Why this may fit</h2> : <h4>Why this may fit</h4>}<p>{preview.reason}</p><p className="jobsMuted">{preview.caution}</p>
    </section> : null}
  </div>;
}
