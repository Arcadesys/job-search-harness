import { createApplicationBatch, listApplicationBatches } from '@/lib/job-queue';
import { mcpOwner, privateJson } from '@/lib/job-mcp-api';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const owner = await mcpOwner(request);
  if (!owner) return privateJson({ error: 'Unauthorized' }, 401);
  try {
    const batches = await listApplicationBatches(owner);
    return privateJson({ selectedBatchId: batches.find((batch) => batch.isSelected)?.id ?? null, batches });
  }
  catch { return privateJson({ error: 'Unable to read private application batches.' }, 503); }
}
