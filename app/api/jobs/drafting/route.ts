import { authorizedJobsAccount } from '@/lib/jobs-auth';
import { assessAndDraft, saveOriginalPosting, saveDraftEdits, getDraftingLead, listDraftingHistory, currentAiUsage } from '@/lib/job-drafting';

export const dynamic = 'force-dynamic';
const privateHeaders = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  const account = await authorizedJobsAccount();
  if (!account) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: privateHeaders });
  const id = new URL(request.url).searchParams.get('leadId') ?? '';
  try {
    const lead = await getDraftingLead(id);
    if (!lead) return Response.json({ error: 'Not found' }, { status: 404, headers: privateHeaders });
    const [history, usage] = await Promise.all([listDraftingHistory(id), currentAiUsage()]);
    return Response.json({ lead, ...history, usage }, { headers: privateHeaders });
  } catch { return Response.json({ error: 'Private drafting storage is unavailable.' }, { status: 503, headers: privateHeaders }); }
}

export async function POST(request: Request) {
  const account = await authorizedJobsAccount();
  if (!account) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: privateHeaders });
  try {
    const body = await request.json();
    const leadId = String(body.leadId ?? '');
    if (body.action === 'source') await saveOriginalPosting(leadId, String(body.postingText ?? ''), String(body.sourceNote ?? ''));
    else if (body.action === 'assess') {
      const result = await assessAndDraft(leadId);
      return Response.json(result, { headers: privateHeaders });
    } else if (body.action === 'edit') await saveDraftEdits(leadId, String(body.resumeVariant ?? ''), String(body.outreach ?? ''));
    else return Response.json({ error: 'Invalid action.' }, { status: 400, headers: privateHeaders });
    return Response.json({ ok: true }, { headers: privateHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Drafting action failed.';
    return Response.json({ error: message }, { status: message.includes('not found') ? 404 : 400, headers: privateHeaders });
  }
}
