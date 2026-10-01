import { neon } from '@neondatabase/serverless';

/** Tagged, parameterized queries only. Neither clients nor agent tools receive
 * this interface; the broker exposes validated domain operations instead. */
export type SqlRow = { [column: string]: any };
export type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<SqlRow[]>;

export function hostedJobSql(): Sql {
  if (process.env.JOBS_STORAGE_MODE === 'local')
    throw new Error('Local jobs require the Jobdesk broker; hosted fallback is disabled.');
  const url = process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Private job database is not configured.');
  const query = neon(url);
  return (strings, ...values) => query(strings, ...values);
}

export function parameterizedSql(db: {
  query: (query: string, values: unknown[]) => Promise<{ rows: SqlRow[] }>;
}): Sql {
  return async (strings, ...values) => {
    const query = strings.reduce(
      (text, part, index) => text + (index ? `$${index}` : '') + part,
      '',
    );
    return (await db.query(query, values)).rows;
  };
}
