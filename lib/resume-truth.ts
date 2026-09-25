import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import {
  RESUME_ACCOMPLISHMENTS, RESUME_COMMUNITY, RESUME_EARLIER, RESUME_EDUCATION,
  RESUME_EXPERIENCE, RESUME_PROFILE, RESUME_SKILLS, RESUME_SUMMARY,
} from '@/lib/resume';

export type TruthClaim = {
  id: string;
  claim: string;
  sourceNote: string;
  reviewStatus: 'unreviewed' | 'reviewed' | 'rejected';
  updatedAt?: string;
};

export type TruthVersion = TruthClaim & { createdAt: string };
type Sql = NeonQueryFunction<false, false>;

function getSql(): Sql {
  const url = process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('NEON_DATABASE_URL or DATABASE_URL is required for private resume storage.');
  return neon(url);
}

/** Every seed starts as unreviewed, with a file and export/property source note. */
export function baselineResumeClaims(): TruthClaim[] {
  const claims: TruthClaim[] = [];
  const add = (id: string, claim: string, source: string) => claims.push({
    id, claim, sourceNote: `Seeded from lib/resume.ts (${source}); verify before reuse.`, reviewStatus: 'unreviewed',
  });
  for (const [key, value] of Object.entries(RESUME_PROFILE)) add(`profile.${key}`, value, `RESUME_PROFILE.${key}`);
  add('summary', RESUME_SUMMARY, 'RESUME_SUMMARY');
  RESUME_ACCOMPLISHMENTS.forEach(({ text }, index) => add(`accomplishment.${index + 1}`, text, `RESUME_ACCOMPLISHMENTS[${index}]`));
  RESUME_EXPERIENCE.forEach((role, index) => {
    add(`experience.${index + 1}.employer`, `${role.company} — ${role.location}`, `RESUME_EXPERIENCE[${index}]`);
    add(`experience.${index + 1}.title`, role.title, `RESUME_EXPERIENCE[${index}].title`);
    add(`experience.${index + 1}.dates`, role.dates, `RESUME_EXPERIENCE[${index}].dates`);
    role.bullets.forEach((bullet, bulletIndex) => add(`experience.${index + 1}.claim.${bulletIndex + 1}`, bullet, `RESUME_EXPERIENCE[${index}].bullets[${bulletIndex}]`));
  });
  RESUME_EARLIER.forEach((role, index) => add(`earlier.${index + 1}`, `${role.org} — ${role.role} (${role.dates})`, `RESUME_EARLIER[${index}]`));
  RESUME_SKILLS.forEach((group, index) => add(`skills.${index + 1}`, `${group.label}: ${group.skills}`, `RESUME_SKILLS[${index}]`));
  RESUME_EDUCATION.forEach((item, index) => add(`education.${index + 1}`, item, `RESUME_EDUCATION[${index}]`));
  add('community', `${RESUME_COMMUNITY.organization} — ${RESUME_COMMUNITY.title}. ${RESUME_COMMUNITY.description}`, 'RESUME_COMMUNITY');
  return claims;
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

export async function listResumeTruth(sql: Sql = getSql()): Promise<TruthClaim[]> {
  await seedResumeTruth(sql);
  const rows = await sql`SELECT id, claim, source_note AS "sourceNote", review_status AS "reviewStatus", updated_at AS "updatedAt" FROM resume_truth_claims ORDER BY id`;
  return rows as TruthClaim[];
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
