import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** JOBDESK_TEST_TMPDIR may select another private, unsynced directory outside Git.
 * Production private-root guards still apply. POSIX tests use /tmp because macOS limits Unix socket paths to 104 bytes and
 * its default temp folder is long; Windows uses named pipes, so any folder works. */
export const tempRoot = (prefix: string) =>
  mkdtemp(path.join(process.env.JOBDESK_TEST_TMPDIR ?? (process.platform === 'win32' ? tmpdir() : '/tmp'), prefix));

/** Windows has no POSIX file modes to assert. */
export const posixModes = process.platform !== 'win32';
