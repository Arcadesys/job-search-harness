import { authorizedJobsAccount } from '@/lib/jobs-auth';
import { listResumeTruth, listResumeTruthVersions, saveResumeTruth } from '@/lib/resume-truth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const accountId = await authorizedJobsAccount();
  if (!accountId) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (id) return Response.json({ versions: await listResumeTruthVersions(id) }, { headers: { 'Cache-Control': 'private, no-store' } });
    const claims = await listResumeTruth();
    return Response.json({ claims }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json({ error: 'Private resume storage is not configured.' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}

export async function PATCH(request: Request) {
  const accountId = await authorizedJobsAccount();
  if (!accountId) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
  try {
    const body = await request.json();
    const claim = { id: String(body.id ?? '').trim(), claim: String(body.claim ?? '').trim(), sourceNote: String(body.sourceNote ?? '').trim(), reviewStatus: body.reviewStatus };
    if (!claim.id || claim.id.length > 200 || !claim.claim || claim.claim.length > 4000 || !claim.sourceNote || claim.sourceNote.length > 1000 || !['unreviewed', 'reviewed', 'rejected'].includes(claim.reviewStatus)) return Response.json({ error: 'Claim, source note, and valid review status are required.' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
    await saveResumeTruth(claim as Parameters<typeof saveResumeTruth>[0]);
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch { return Response.json({ error: 'Unable to save private resume truth.' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } }); }
}
