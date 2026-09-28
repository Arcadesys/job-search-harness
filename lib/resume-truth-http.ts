import { reviewBatchSchema, truthProgress, type ReviewClaim, type TruthChange } from './resume-truth-review';

type Dependencies = {
  authorize: () => Promise<string | null>;
  save: (changes: TruthChange[]) => Promise<{ claims: ReviewClaim[]; conflicts: string[] }>;
  list: () => Promise<ReviewClaim[]>;
};

/** Shared by the authenticated Next route and isolated database/browser tests. */
export async function handleTruthReview(request: Request, dependencies: Dependencies) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!await dependencies.authorize()) return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  const parsed = reviewBatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Select valid truths with their current versions. Claim and source note must not be empty.' }, { status: 400, headers });
  try {
    const result = await dependencies.save(parsed.data.changes);
    if (result.conflicts.length) return Response.json({ error: 'Some truths changed since you opened this page. Nothing was saved. Refresh those truths and review them again.', conflicts: result.conflicts }, { status: 409, headers });
    const claims = await dependencies.list();
    return Response.json({ claims, updated: result.claims, progress: truthProgress(claims) }, { headers });
  } catch {
    return Response.json({ error: 'Could not confirm the save. Your selection and edits are still here. Retry, or refresh to check the saved state.' }, { status: 503, headers });
  }
}
