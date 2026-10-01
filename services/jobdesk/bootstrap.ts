import { seedResumeTruth } from '../../lib/resume-truth';
import { initializeSearchQueries } from '../../lib/job-discovery';
import type { Sql } from '../../lib/job-storage';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const reportsSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
        organization: z.string().min(1).max(200),
        externalJobId: z.string().max(160),
        state: z.enum(['user_reported_submitted', 'referral_expected']),
        reportedOn: z.iso.date(),
        sourceNote: z.string().min(1).max(1000),
      })
      .strict(),
  )
  .max(100);
export type UserReport = z.infer<typeof reportsSchema>[number];
export async function privateBootstrap(root: string): Promise<UserReport[]> {
  try {
    return reportsSchema.parse(
      JSON.parse(await readFile(path.join(root, 'bootstrap.json'), 'utf8')),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function bootstrap(sql: Sql, reports: UserReport[] = []) {
  await seedResumeTruth(sql);
  await initializeSearchQueries(sql);
  const input = JSON.stringify(reportsSchema.parse(reports));
  await sql`WITH incoming AS (SELECT * FROM jsonb_to_recordset(${input}::jsonb)
    AS x(id text,organization text,"externalJobId" text,state text,"reportedOn" date,"sourceNote" text))
    INSERT INTO jobdesk_user_reports(id,organization,external_job_id,state,reported_on,source_note)
    SELECT id,organization,"externalJobId",state,"reportedOn","sourceNote" FROM incoming ON CONFLICT(id) DO NOTHING`;
}
