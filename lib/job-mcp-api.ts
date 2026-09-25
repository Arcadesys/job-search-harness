import { authenticateMcpToken, bearerToken } from '@/lib/job-queue';

export const PRIVATE_API_HEADERS = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Authorization' };

export async function mcpOwner(request: Request): Promise<string | null> {
  const token = bearerToken(request);
  return token ? authenticateMcpToken(token) : null;
}

export function privateJson(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: PRIVATE_API_HEADERS });
}

export function apiError(error: unknown, message: string): Response {
  return privateJson({ error: message }, 400);
}
