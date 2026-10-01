import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { brokerCall } from './client';
import { JobdeskStore, DEFAULT_ROOT, recoverOwnerLock, PGLITE_VERSION } from './store';

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'open') {
    const { url } = await brokerCall('browser.open', []);
    await new Promise<void>((resolve, reject) =>
      execFile('/usr/bin/open', [url], { env: process.env }, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    console.log('Opened the private local Jobdesk session.');
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(await brokerCall('health', [])));
    return;
  }
  if (command === 'backup') {
    console.log(JSON.stringify(await brokerCall('backup', [])));
    return;
  }
  if (command === 'recover-lock') {
    await recoverOwnerLock(process.env.JOBDESK_DATA_DIR ?? DEFAULT_ROOT);
    console.log(
      'Recovered the stopped owner lock. Submission attempts still require reconciliation.',
    );
    return;
  }
  if (command === 'restore') {
    if (args.length !== 2) throw new Error('Usage: restore BACKUP_DIRECTORY NEW_DATA_DIRECTORY');
    const [backup, destination] = args;
    const manifest = JSON.parse(await readFile(path.join(backup, 'manifest.json'), 'utf8'));
    const data = await readFile(path.join(backup, 'database.tar.gz'));
    if (
      manifest.format !== 1 ||
      manifest.pglite !== PGLITE_VERSION ||
      createHash('sha256').update(data).digest('hex') !== manifest.sha256
    )
      throw new Error('Backup manifest or runtime checksum does not match.');
    const artifacts: { id: string; bytes: Buffer }[] = [];
    if (!Array.isArray(manifest.artifacts)) throw new Error('Invalid artifact manifest.');
    for (const artifact of manifest.artifacts) {
      if (!/^[a-f0-9-]{36}$/.test(artifact.id) || artifacts.some((file) => file.id === artifact.id))
        throw new Error('Invalid or duplicate artifact in manifest.');
      const bytes = await readFile(path.join(backup, 'artifacts', `${artifact.id}.pdf`));
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.content_hash)
        throw new Error('Artifact checksum mismatch.');
      artifacts.push({ id: artifact.id, bytes });
    }
    const store = await JobdeskStore.open(destination, undefined, new Blob([new Uint8Array(data)]),
      async (root) => {
        await mkdir(path.join(root, 'artifacts'), { recursive: true, mode: 0o700 });
        for (const artifact of artifacts)
          await writeFile(path.join(root, 'artifacts', `${artifact.id}.pdf`), artifact.bytes,
            { flag: 'wx', mode: 0o600 });
      });
    try {
      console.log(
        'Restored and verified a separate database. Review it before any configuration switch.',
      );
    } finally {
      await store.close();
    }
    return;
  }
  throw new Error(
    'Commands: open, status, backup, recover-lock, restore BACKUP_DIRECTORY NEW_DATA_DIRECTORY',
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Jobdesk command failed.');
  process.exitCode = 1;
});
