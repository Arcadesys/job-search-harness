import { readApplicationBatchItem, updateApplicationBatchItem, validBatchStatus } from '@/lib/job-queue';
import { mcpOwner, privateJson } from '@/lib/job-mcp-api';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const owner = await mcpOwner(request);
  if (!owner) return privateJson({ error: 'Unauthorized' }, 401);
  const { itemId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return privateJson({ error: 'Application item not found.' }, 404);
  try {
    const item = await readApplicationBatchItem(owner, itemId);
    return item ? privateJson({ item }) : privateJson({ error: 'Application item not found.' }, 404);
  } catch { return privateJson({ error: 'Unable to read private application item.' }, 503); }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const owner = await mcpOwner(request);
  if (!owner) return privateJson({ error: 'Unauthorized' }, 401);
  const { itemId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return privateJson({ error: 'Application item not found.' }, 404);
  try {
    const body = await request.json();
    if (!validBatchStatus(body?.status) || typeof body?.note !== 'undefined' && typeof body.note !== 'string') return privateJson({ error: 'Provide a valid status and optional note.' }, 400);
    const item = await updateApplicationBatchItem(owner, itemId, body.status, body.note ?? '');
    return item ? privateJson({ item }) : privateJson({ error: 'Application item not found or already submitted.' }, 404);
  } catch (error) {
    if (error instanceof SyntaxError) return privateJson({ error: 'Invalid JSON body.' }, 400);
    if (error instanceof Error && error.message.includes('confirmed submission')) return privateJson({ error: error.message }, 409);
    return privateJson({ error: 'Unable to update private application item.' }, 503);
  }
}
