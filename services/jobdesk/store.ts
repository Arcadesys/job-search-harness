import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { parameterizedSql, type Sql } from '../../lib/job-storage';
import { migrate, MIGRATIONS } from './migrate';

export const PGLITE_VERSION = '0.5.8';
export const DEFAULT_ROOT = path.join(homedir(), 'Library/Application Support/Arcades Jobdesk');

export async function privateRoot(directory: string) {
  let root = path.resolve(directory);
  if (/\/(?:Mobile Documents|CloudStorage|Dropbox|OneDrive)(?:\/|$)/i.test(root))
    throw new Error('Jobdesk state must be outside synced folders.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink())
    throw new Error('Jobdesk state must not use a symlinked root.');
  root = await realpath(root);
  if (/\/(?:Mobile Documents|CloudStorage|Dropbox|OneDrive)(?:\/|$)/i.test(root))
    throw new Error('Jobdesk state must be outside synced folders.');
  const info = await stat(root);
  if (info.uid !== process.getuid?.() || info.mode & 0o077)
    throw new Error('Jobdesk root must be owned by the current user with permissions 0700.');
  for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
    try {
      await access(path.join(ancestor, '.git'));
      throw new Error('Private Jobdesk state cannot be inside a Git checkout.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (path.dirname(ancestor) === ancestor) break;
  }
  return root;
}

/** Recovery is explicit and only allowed after proving the old PID is gone.
 * Never recover a lease or retry an employer submission here. */
export async function recoverOwnerLock(directory: string) {
  const root = await privateRoot(directory);
  const lock = path.join(root, 'owner.lock');
  const before = await readFile(lock, 'utf8');
  const owner = JSON.parse(before) as { pid: number };
  if (!Number.isInteger(owner.pid) || owner.pid <= 0)
    throw new Error('Invalid owner lock; inspect it manually.');
  try {
    process.kill(owner.pid, 0);
    throw new Error('A database owner is still running.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  if ((await readFile(lock, 'utf8')) !== before)
    throw new Error('Owner lock changed during recovery.');
  await rm(lock);
}

export class JobdeskStore {
  readonly sql: Sql;
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closed = false;
  private constructor(
    readonly root: string,
    readonly db: PGlite,
    private lockValue: string,
  ) {
    this.sql = parameterizedSql(db);
  }

  static async open(directory = DEFAULT_ROOT, migrations = MIGRATIONS, restore?: Blob,
    stageRestoredArtifacts?: (root: string) => Promise<void>) {
    const root = await privateRoot(directory);
    const lockValue = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    const lock = await open(path.join(root, 'owner.lock'), 'wx', 0o600).catch(() => {
      throw new Error('Jobdesk already has an owner or needs explicit crash-lock recovery.');
    });
    await lock.writeFile(lockValue);
    await lock.close();
    let db: PGlite | undefined;
    try {
      if (restore) {
        try {
          await access(path.join(root, 'database'));
          throw new Error('Restore requires a new directory.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        // Stage verified restore artifacts while holding the sole-owner lock,
        // before migration's pre-upgrade backup reads the restored registry.
        await stageRestoredArtifacts?.(root);
      }
      db = await PGlite.create({
        dataDir: path.join(root, 'database'),
        loadDataDir: restore,
        relaxedDurability: false,
      });
      const store = new JobdeskStore(root, db, lockValue);
      await migrate(db, migrations, () => store.backup());
      await mkdir(path.join(root, 'artifacts'), { recursive: true, mode: 0o700 });
      await chmod(path.join(root, 'database'), 0o700);
      return store;
    } catch (error) {
      await db?.close();
      await rm(path.join(root, 'owner.lock'));
      throw error;
    }
  }

  /** Serialize domain operations and backups, not long database transactions. */
  run<T>(operation: (sql: Sql) => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Jobdesk is shutting down.'));
    const result = this.tail.then(() => operation(this.sql));
    this.tail = result.catch(() => undefined);
    return result;
  }

  async backup() {
    return this.run(async () => {
      const id = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
      const directory = path.join(this.root, 'backups', id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const dump = Buffer.from(await (await this.db.dumpDataDir()).arrayBuffer());
      await writeFile(path.join(directory, 'database.tar.gz'), dump, { mode: 0o600, flag: 'wx' });
      const tables = (
        await this.db.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'job_mcp_tokens' ORDER BY tablename",
        )
      ).rows;
      const logical: Record<string, unknown> = {};
      for (const { tablename } of tables) {
        if (!/^[a-z_]+$/.test(tablename)) throw new Error('Unexpected export table.');
        logical[tablename] = (await this.db.query(`SELECT * FROM "${tablename}"`)).rows;
      }
      await writeFile(path.join(directory, 'logical.json'), JSON.stringify(logical), {
        mode: 0o600,
        flag: 'wx',
      });
      const artifacts = tables.some((table) => table.tablename === 'jobdesk_artifacts')
        ? await this.sql`SELECT id, content_hash FROM jobdesk_artifacts ORDER BY id`
        : [];
      await mkdir(path.join(directory, 'artifacts'), { mode: 0o700 });
      for (const artifact of artifacts) {
        if (!/^[a-f0-9-]{36}$/.test(artifact.id)) throw new Error('Invalid artifact registry.');
        const original = path.join(this.root, 'artifacts', `${artifact.id}.pdf`);
        if (
          createHash('sha256')
            .update(await readFile(original))
            .digest('hex') !== artifact.content_hash
        )
          throw new Error('Artifact checksum mismatch.');
        await cp(original, path.join(directory, 'artifacts', `${artifact.id}.pdf`), {
          errorOnExist: true,
          force: false,
        });
      }
      const manifest = {
        format: 1,
        pglite: PGLITE_VERSION,
        createdAt: new Date().toISOString(),
        sha256: createHash('sha256').update(dump).digest('hex'),
        migrations: (
          await this.db.query(
            'SELECT version, checksum, applied_at FROM jobdesk_migrations ORDER BY version',
          )
        ).rows,
        artifacts,
      };
      await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), {
        mode: 0o600,
        flag: 'wx',
      });
      return { directory, manifest };
    });
  }

  async close() {
    if (this.closed) return;
    this.closing = true;
    await this.tail;
    await this.db.close();
    if ((await readFile(path.join(this.root, 'owner.lock'), 'utf8')) !== this.lockValue)
      throw new Error('Database owner lock changed.');
    await rm(path.join(this.root, 'owner.lock'));
    this.closed = true;
  }
}
