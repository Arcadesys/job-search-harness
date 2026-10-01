import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';

export const MIGRATIONS = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
export async function migrate(
  db: PGlite,
  directory = MIGRATIONS,
  beforeUpgrade?: () => Promise<unknown>,
) {
  const files = (await readdir(directory))
    .filter((file) => /^\d{4}_[a-z_]+\.sql$/.test(file))
    .sort();
  await db.exec(
    'CREATE TABLE IF NOT EXISTS jobdesk_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const applied = (
    await db.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM jobdesk_migrations ORDER BY version',
    )
  ).rows;
  if (applied.some((row) => !files.includes(row.version)))
    throw new Error('Database schema is newer than this runtime or a migration is missing.');
  const sources = await Promise.all(
    files.map(async (version) => {
      const source = await readFile(path.join(directory, version), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      return { version, source, checksum };
    }),
  );
  for (const { version, checksum } of sources) {
    const previous = applied.find((row) => row.version === version);
    if (previous && previous.checksum !== checksum)
      throw new Error(`Migration checksum drift: ${version}`);
  }
  if (applied.some((row, index) => row.version !== files[index]))
    throw new Error('Migration ledger has a gap or an unsupported order.');
  if (applied.length && sources.length > applied.length) await beforeUpgrade?.();
  for (const { version, source, checksum } of sources) {
    if (applied.some((row) => row.version === version)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(source);
      await tx.query('INSERT INTO jobdesk_migrations (version, checksum) VALUES ($1, $2)', [
        version,
        checksum,
      ]);
    });
  }
  return (
    await db.query('SELECT version, checksum, applied_at FROM jobdesk_migrations ORDER BY version')
  ).rows;
}
