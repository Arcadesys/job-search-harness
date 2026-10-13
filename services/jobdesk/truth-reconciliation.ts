import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '../../lib/job-storage';
import { truthStatuses, type ReviewClaim } from '../../lib/resume-truth-review';
import { JobdeskError } from './errors';

const recordSchema = z.object({
  id: z.string().min(1).max(160),
  claim: z.string().min(1).max(4000).refine((value) => value.trim().length > 0),
  sourceNote: z.string().min(1).max(1000),
  reviewStatus: z.enum(truthStatuses),
  version: z.string().min(1).max(100),
}).strict();
const exportSchema = z.object({
  claims: z.array(recordSchema.extend({ updatedAt: z.string().min(1).max(100) })).min(1).max(200),
}).strict().refine(({ claims }) => new Set(claims.map((row) => row.id)).size === claims.length,
  'Export IDs must be unique.');

export const truthReconciliationSchema = z.object({
  exportJson: z.string().min(1).max(200000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceOrigin: z.literal('https://work.thearcades.me'),
  sourceReference: z.string().regex(/^file_[a-f0-9]{32}$/),
  expected: z.array(z.object({
    id: z.string().min(1).max(160),
    record: recordSchema.nullable(),
  }).strict()).min(1).max(200),
}).strict().refine(({ expected }) => new Set(expected.map((row) => row.id)).size === expected.length,
  'Expected IDs must be unique.');
export type TruthReconciliationInput = z.infer<typeof truthReconciliationSchema>;

/** Explicit recovery of exported decisions, never a blanket approval or hosted write.
 * The sole owner wraps this entire operation in one transaction. Foreign version
 * strings are provenance only; local timestamps and every prior version survive.
 */
export async function reconcileHostedTruth(raw: TruthReconciliationInput, sql: Sql) {
  const input = truthReconciliationSchema.parse(raw);
  if (createHash('sha256').update(input.exportJson).digest('hex') !== input.sha256)
    throw new Error('Export checksum does not match.');
  const source = exportSchema.parse(JSON.parse(input.exportJson));
  const decisions = source.claims.filter((row) => row.reviewStatus !== 'unreviewed');
  if (decisions.length !== input.expected.length || decisions.some((row) =>
    !input.expected.some((expected) => expected.id === row.id &&
      (expected.record === null || expected.record.id === row.id))))
    throw new Error('Expected records must match exactly the exported decisions.');
  const targets = decisions.map((row) => ({
    ...row,
    sourceNote: `${row.sourceNote}\nRecovered from user-supplied ${input.sourceOrigin} export; source version ${row.version}; SHA-256 ${input.sha256}; source ${input.sourceReference}.`,
  }));
  if (targets.some((row) => row.sourceNote.length > 1000))
    throw new Error('Original provenance plus recovery note exceeds the source-note limit.');
  const ids = targets.map((row) => row.id);
  const existing = await sql`SELECT id, claim, source_note AS "sourceNote", review_status AS "reviewStatus",
    updated_at AS "updatedAt", updated_at::text AS version FROM resume_truth_claims
    WHERE id=ANY(${ids}) ORDER BY id FOR UPDATE` as ReviewClaim[];
  const sameContent = (a: z.infer<typeof recordSchema>, b: z.infer<typeof recordSchema>) =>
    a.id === b.id && a.claim === b.claim && a.sourceNote === b.sourceNote && a.reviewStatus === b.reviewStatus;
  const alreadyApplied: string[] = [];
  const pending: typeof targets = [];
  const conflicts: string[] = [];
  for (const target of targets) {
    const current = existing.find((row) => row.id === target.id);
    const expected = input.expected.find((row) => row.id === target.id)!.record;
    // Identical retries never append history or replace a newer identical record.
    if (current && sameContent(current, target)) alreadyApplied.push(target.id);
    else if ((!current && expected === null) || (current && expected &&
      current.version === expected.version && sameContent(current, expected))) pending.push(target);
    else conflicts.push(target.id);
  }
  if (conflicts.length) throw new JobdeskError('TRUTH_CONFLICT',
    `Local truth changed or a source ID conflicts: ${conflicts.join(', ')}. No records changed.`);
  const changed: ReviewClaim[] = [];
  const added: ReviewClaim[] = [];
  for (const target of pending) {
    const isNew = !existing.some((row) => row.id === target.id);
    const saved = isNew
      ? await sql`INSERT INTO resume_truth_claims (id,claim,source_note,review_status)
          VALUES (${target.id},${target.claim},${target.sourceNote},${target.reviewStatus})
          RETURNING id,claim,source_note AS "sourceNote",review_status AS "reviewStatus",
            updated_at AS "updatedAt",updated_at::text AS version`
      : await sql`UPDATE resume_truth_claims SET claim=${target.claim},source_note=${target.sourceNote},
          review_status=${target.reviewStatus},updated_at=clock_timestamp() WHERE id=${target.id}
          RETURNING id,claim,source_note AS "sourceNote",review_status AS "reviewStatus",
            updated_at AS "updatedAt",updated_at::text AS version`;
    await sql`INSERT INTO resume_truth_versions (claim_id,claim,source_note,review_status)
      VALUES (${target.id},${target.claim},${target.sourceNote},${target.reviewStatus})`;
    (isNew ? added : changed).push(saved[0] as ReviewClaim);
  }
  return { sha256: input.sha256, changed, added, alreadyApplied,
    unreviewedSourceIds: source.claims.filter((row) => row.reviewStatus === 'unreviewed').map((row) => row.id) };
}
