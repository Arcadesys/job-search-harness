import { authorizedJobsAccount } from '@/lib/jobs-auth';
import { getDraftingLead, listDraftingHistory } from '@/lib/job-drafting';
import { renderApplicationPdf } from '@/lib/job-pdf';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const account = await authorizedJobsAccount();
  if (!account) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
  const id = new URL(request.url).searchParams.get('leadId') ?? '';
  const lead = await getDraftingLead(id);
  const { draft } = await listDraftingHistory(id);
  if (!lead || !draft) return Response.json({ error: 'Draft not found.' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
  try {
    const pdf = await renderApplicationPdf({
      title: String(lead.title), organization: String(lead.organization ?? ''),
      location: String(lead.location ?? ''), sourceUrl: String(lead.sourceUrl),
      postingSourceNote: String(lead.postingSourceNote ?? ''),
    }, {
      resumeVariant: String(draft.resumeVariant), outreach: String(draft.outreach),
      truthSnapshot: (draft.truthSnapshot ?? []) as Array<{ id: string; claim: string; sourceNote: string }>,
    });
    return new Response(Buffer.from(pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="private-application-draft.pdf"', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'PDF export failed.' }, { status: 422, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
