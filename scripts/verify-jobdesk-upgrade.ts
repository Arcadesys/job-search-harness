/** Restore a separate copy and compare all original fields, without logging private rows. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { JobdeskStore, PGLITE_VERSION } from '../services/jobdesk/store';
import { initializeService } from '../services/jobdesk/service';
import { canonical, fingerprint } from '../lib/workflow-hash';

export async function verifyUpgrade(backup: string, destination: string) {
  const manifest = JSON.parse(await readFile(path.join(backup, 'manifest.json'), 'utf8'));
  const dump = await readFile(path.join(backup, 'database.tar.gz'));
  if (manifest.format !== 1 || manifest.pglite !== PGLITE_VERSION || createHash('sha256').update(dump).digest('hex') !== manifest.sha256)
    throw new Error('Backup checksum or runtime does not match.');
  const logical = JSON.parse(await readFile(path.join(backup, 'logical.json'), 'utf8'));
  const staged: { id: string; bytes: Buffer }[] = [];
  for (const artifact of manifest.artifacts) {
    if (!/^[a-f0-9-]{36}$/.test(artifact.id)) throw new Error('Invalid artifact ID.');
    const bytes = await readFile(path.join(backup, 'artifacts', `${artifact.id}.pdf`));
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.content_hash) throw new Error('Backup artifact checksum mismatch.');
    staged.push({ id: artifact.id, bytes });
  }
  const store = await JobdeskStore.open(destination, undefined, new Blob([new Uint8Array(dump)]), async (root) => {
    await mkdir(path.join(root, 'artifacts'), { recursive: true, mode: 0o700 });
    for (const artifact of staged) await writeFile(path.join(root, 'artifacts', `${artifact.id}.pdf`), artifact.bytes, { flag: 'wx', mode: 0o600 });
  });
  try {
    const tables: { table: string; rows: number; originalFieldsMatch: boolean }[] = [];
    for (const [table, rows] of Object.entries(logical) as [string, Record<string, unknown>[]][]) {
      if (table === 'jobdesk_migrations') continue;
      if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid backup table.');
      const current = JSON.parse(JSON.stringify((await store.db.query(`SELECT * FROM "${table}"`)).rows)) as Record<string, unknown>[];
      // New columns are allowed. Every existing field and every existing row must match.
      const keys = rows.length ? Object.keys(rows[0]) : [];
      const normalized = (items: Record<string, unknown>[]) => items.map((row) => Object.fromEntries(keys.map((key) => [key, row[key]])))
        .sort((a, b) => canonical(a).localeCompare(canonical(b)));
      const matches = current.length === rows.length && fingerprint(normalized(current)) === fingerprint(normalized(rows));
      tables.push({ table, rows: rows.length, originalFieldsMatch: matches });
      if (!matches) throw new Error(`Upgrade changed original fields in ${table}. Keep the previous installation.`);
    }
    const openAttempts = (await store.sql`SELECT count(*)::int AS n FROM jobdesk_submission_attempts WHERE state IN ('pending','uncertain')`)[0].n;
    await initializeService(store);
    const report = { verified: true, destination, sourceBackup: backup, tables, artifactsVerified: staged.length,
      representativeRecordsChecked: tables.reduce((sum, table) => sum + Math.min(3, table.rows), 0),
      migrations: (await store.sql`SELECT version FROM jobdesk_migrations ORDER BY version`).map((row) => row.version),
      submissionReconciliationRequired: openAttempts > 0 };
    await writeFile(path.join(destination, 'upgrade-verification.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    return report;
  } finally { await store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [backup, destination] = process.argv.slice(2);
  if (!backup || !destination) throw new Error('Usage: verify-jobdesk-upgrade.ts BACKUP_DIRECTORY NEW_DATA_DIRECTORY');
  verifyUpgrade(backup, destination).then((report) => console.log(JSON.stringify(report))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
