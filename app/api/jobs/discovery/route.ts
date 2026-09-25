import { timingSafeEqual } from 'node:crypto';
import { runDailySearch } from '@/lib/job-discovery';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!secret || !supplied) return false;
  const left = Buffer.from(secret);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  try {
    const result = await runDailySearch();
    return Response.json(result, { status: result.status === 'failed' ? 502 : 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Discovery service is unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
