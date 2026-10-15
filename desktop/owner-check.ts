import { readdir } from 'node:fs/promises';

/** A running owner from another release would serve a different schema to this cockpit.
 * Attach only when its migrations match this app's exactly; never replace or stop it. */
export async function assertCompatibleOwner(health: { migrations?: { version: string }[] }, migrationsDir: string) {
  const expected = (await readdir(migrationsDir)).filter((name) => /^\d{4}_[a-z_]+\.sql$/.test(name)).sort();
  const actual = (health.migrations ?? []).map((row) => row.version).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('A different version of Job Search Harness is already running. Quit it (or run its stop-background command), then open this app again. Nothing was changed.');
}
