import { listApplicationBatchItems } from '@/lib/job-queue';
import { mcpOwner, privateJson } from '@/lib/job-mcp-api';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const owner = await mcpOwner(request);
  if (!owner) return privateJson({ error: 'Unauthorized' }, 401);
  const { batchId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) return privateJson({ error: 'Batch not found.' }, 404);
  try { return privateJson({ items: await listApplicationBatchItems(owner, batchId) }); }
  catch { return privateJson({ error: 'Unable to read private batch items.' }, 503); }
}
