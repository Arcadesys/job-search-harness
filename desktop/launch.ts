import { startDetachedOwner } from '../services/jobdesk/owner-launch';
import { brokerCall } from '../services/jobdesk/client';
import { brokerEndpoint, defaultDataRoot } from '../services/jobdesk/paths.mjs';
import { readdir } from 'node:fs/promises';

async function main() {
  const root = defaultDataRoot();
  await startDetachedOwner(root);
  const endpoint = brokerEndpoint(root);
  const health = await brokerCall('health', [], endpoint);
  const expected = (await readdir(new URL('../db/migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
  const actual = health.migrations.map((row: { version: string }) => row.version).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('A different version of Job Search Harness is already running. Stop that version using its documented shutdown command, then reopen this app. No running owner was replaced.');
  const session = await brokerCall('browser.open', [], endpoint);
  process.stdout.write(JSON.stringify(session));
}

main().catch(error => {
  process.stderr.write(error instanceof Error ? error.message : 'Local workspace startup failed.');
  process.exitCode = 1;
});
