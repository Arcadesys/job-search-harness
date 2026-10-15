import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir } from 'node:fs/promises';
import { assertCompatibleOwner } from './owner-check';
import { migrationsDirectory } from '../services/jobdesk/migrate';

test('the app attaches only to an owner with exactly its migrations', async () => {
  const dir = migrationsDirectory();
  const versions = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort().map((version) => ({ version }));
  await assertCompatibleOwner({ migrations: versions }, dir);
  await assert.rejects(assertCompatibleOwner({ migrations: versions.slice(0, -1) }, dir), /different version/);
  await assert.rejects(assertCompatibleOwner({ migrations: [...versions, { version: '9999_future.sql' }] }, dir), /different version/);
  await assert.rejects(assertCompatibleOwner({}, dir), /different version/);
});
