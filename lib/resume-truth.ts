import { hostedJobSql, type Sql } from './job-storage';
import { reviewBatchSchema, type TruthChange, type ReviewClaim } from './resume-truth-review';
import truthSeeds from './resume-truth-seeds.json';

export type TruthClaim = {
  id: string;
  claim: string;
  sourceNote: string;
  reviewStatus: 'unreviewed' | 'reviewed' | 'rejected';
  updatedAt?: string;
  version?: string;
};

export type TruthVersion = TruthClaim & { createdAt: string };

const getSql = hostedJobSql;

/**
 * Every seed starts as unreviewed. The seeds are a frozen snapshot of the
 * work.thearcades.me résumé exports at the time this harness was split out;
 * their positional IDs and wording must not change, because stored claims key
 * off them.
 */
export function baselineResumeClaims(): TruthClaim[] {
  return (truthSeeds as TruthClaim[]).map((claim) => ({ ...claim }));
}

export async function seedResumeTruth(sql: Sql = getSql()): Promise<void> {
  const claims = baselineResumeClaims();
  const payload = JSON.stringify(claims.map((claim) => ({
    id: claim.id, claim: claim.claim, source_note: claim.sourceNote, review_status: claim.reviewStatus,
  })));
  await sql`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${payload}::jsonb)
        AS x(id text, claim text, source_note text, review_status text)
    ), inserted AS (
      INSERT INTO resume_truth_claims (id, claim, source_note, review_status)
      SELECT id, claim, source_note, review_status FROM incoming
      ON CONFLICT (id) DO NOTHING
      RETURNING id, claim, source_note, review_status
    )
    INSERT INTO resume_truth_versions (claim_id, claim, source_note, review_status)
    SELECT id, claim, source_note, review_status FROM inserted
  `;
}

export async function listResumeTruth(sql: Sql = getSql()): Promise<ReviewClaim[]> {
  await seedResumeTruth(sql);
  const rows = await sql`SELECT id, claim, source_note AS "sourceNote", review_status AS "reviewStatus", updated_at AS "updatedAt", updated_at::text AS version FROM resume_truth_claims ORDER BY id`;
  return rows as ReviewClaim[];
}

/** Atomically updates the current claim and appends its immutable version. */
export async function saveResumeTruth(claim: TruthClaim, sql: Sql = getSql()): Promise<void> {
  await sql`
    WITH saved AS (
      INSERT INTO resume_truth_claims (id, claim, source_note, review_status)
      VALUES (${claim.id}, ${claim.claim}, ${claim.sourceNote}, ${claim.reviewStatus})
      ON CONFLICT (id) DO UPDATE SET
        claim = EXCLUDED.claim, source_note = EXCLUDED.source_note,
        review_status = EXCLUDED.review_status, updated_at = now()
      RETURNING id, claim, source_note, review_status
    )
    INSERT INTO resume_truth_versions (claim_id, claim, source_note, review_status)
    SELECT id, claim, source_note, review_status FROM saved
  `;
}

export async function listResumeTruthVersions(id: string, sql: Sql = getSql()): Promise<TruthVersion[]> {
  const rows = await sql`SELECT claim_id AS id, claim, source_note AS "sourceNote", review_status AS "reviewStatus", created_at AS "createdAt" FROM resume_truth_versions WHERE claim_id = ${id} ORDER BY created_at DESC, id DESC`;
  return rows as TruthVersion[];
}


/** Locks the entire selection before checking versions. A conflict writes nothing.
 * Timestamp text is an opaque token: retaining PostgreSQL precision avoids JS
 * millisecond rounding and remains compatible with the legacy PATCH writer.
 */
export async function reviewResumeTruth(changes: TruthChange[], sql: Sql = getSql()): Promise<{ claims: ReviewClaim[]; conflicts: string[] }> {
  const input = reviewBatchSchema.parse({ changes });
  const payload = JSON.stringify(input.changes);
  const rows = await sql`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${payload}::jsonb)
      AS x(id text, "expectedVersion" text, "reviewStatus" text, claim text, "sourceNote" text)
    ), locked AS MATERIALIZED (
      SELECT c.* FROM resume_truth_claims c JOIN incoming i ON c.id = i.id
      ORDER BY c.id FOR UPDATE OF c
    ), conflicts AS MATERIALIZED (
      SELECT i.id FROM incoming i LEFT JOIN locked c ON c.id = i.id
      WHERE c.id IS NULL OR c.updated_at::text <> i."expectedVersion"
    ), saved AS (
      UPDATE resume_truth_claims c
      SET claim = COALESCE(i.claim, l.claim), source_note = COALESCE(i."sourceNote", l.source_note),
          review_status = i."reviewStatus", updated_at = clock_timestamp()
      FROM incoming i JOIN locked l ON l.id = i.id
      WHERE c.id = i.id AND NOT EXISTS (SELECT 1 FROM conflicts)
      RETURNING c.id, c.claim, c.source_note AS "sourceNote", c.review_status AS "reviewStatus",
                c.updated_at AS "updatedAt", c.updated_at::text AS version
    ), recorded AS (
      INSERT INTO resume_truth_versions (claim_id, claim, source_note, review_status)
      SELECT id, claim, "sourceNote", "reviewStatus" FROM saved RETURNING id
    )
    SELECT COALESCE((SELECT jsonb_agg(s) FROM saved s), '[]'::jsonb) AS claims,
           COALESCE((SELECT jsonb_agg(id) FROM conflicts), '[]'::jsonb) AS conflicts,
           (SELECT count(*) FROM recorded) AS recorded
  `;
  return rows[0] as { claims: ReviewClaim[]; conflicts: string[] };
}
