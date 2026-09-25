import { requireJobsAccount } from '@/lib/jobs-auth';
import { listLeads } from '@/lib/job-discovery';
import { listResumeTruth } from '@/lib/resume-truth';

export const dynamic = 'force-dynamic';

export async function GET() {
  await requireJobsAccount();
  const [leads, claims] = await Promise.all([listLeads(), listResumeTruth()]);
  const payload = {
    generatedAt: new Date().toISOString(),
    instructions: 'Search results are leads. Open the source posting to verify current details before drafting. Use reviewed resume claims with their source notes; do not treat unreviewed claims as approved.',
    keptLeads: leads.filter((lead: any) => lead.decision === 'keep').map((lead: any) => ({
      title: lead.title, organization: lead.organization, location: lead.location, sourceUrl: lead.sourceUrl,
      verificationStatus: lead.verificationStatus, applicationStage: lead.applicationStage,
      nextAction: lead.nextAction, nextActionDate: lead.nextActionDate, notes: lead.notes,
    })),
    reviewedResumeClaims: claims.filter((claim) => claim.reviewStatus === 'reviewed').map((claim) => ({ id: claim.id, claim: claim.claim, sourceNote: claim.sourceNote })),
  };
  return Response.json(payload, {
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'attachment; filename="private-job-drafting-handoff.json"',
    },
  });
}
