import { recordApplicationReceipt } from '@/lib/job-queue';
import { mcpOwner, privateJson } from '@/lib/job-mcp-api';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const owner = await mcpOwner(request);
  if (!owner) return privateJson({ error: 'Unauthorized' }, 401);
  const { itemId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return privateJson({ error: 'Application item not found.' }, 404);
  try {
    const body = await request.json();
    if (!body || typeof body.idempotencyKey !== 'string' || typeof body.confirmation !== 'string' || typeof body.confirmationUrl !== 'undefined' && typeof body.confirmationUrl !== 'string') return privateJson({ error: 'Provide a confirmed submission receipt.' }, 400);
    const receipt = await recordApplicationReceipt(owner, itemId, body);
    return privateJson({ receipt }, 201);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof Error && /Provide an idempotency|Confirmation link/.test(error.message)) return privateJson({ error: error instanceof Error ? error.message : 'Invalid request.' }, 400);
    return privateJson({ error: 'Unable to record submission. Check item ownership and receipt idempotency.' }, 409);
  }
}
