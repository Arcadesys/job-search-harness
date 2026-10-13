import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Shared by the owner, the CLI and the dependency-free MCP adapter, so it is
// plain JavaScript. Every location stays per-user and outside synced folders.
export const APP_NAME = 'Job Search Harness';

/** Folders used by earlier releases. An existing one is reused, never moved. */
export function legacyRoots({ platform = process.platform, home = homedir() } = {}) {
  return platform === 'darwin'
    ? [path.join(home, 'Library/Application Support/Arcades Jobdesk')]
    : [];
}

export function defaultDataRoot({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  exists = existsSync,
} = {}) {
  if (env.JOBDESK_DATA_DIR) return env.JOBDESK_DATA_DIR;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  let root;
  if (platform === 'darwin') root = join(home, 'Library/Application Support', APP_NAME);
  // LOCALAPPDATA, not APPDATA: roaming profiles would sync the database.
  else if (platform === 'win32') root = join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), APP_NAME);
  else root = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'job-search-harness');
  if (!exists(root)) {
    const legacy = legacyRoots({ platform, home }).find((candidate) => exists(candidate));
    if (legacy) return legacy;
  }
  return root;
}

/** A user-only Unix socket inside the data root, or a named pipe on Windows,
 * where pipes live in a global namespace and are keyed by the data root. */
export function brokerEndpoint(root, { platform = process.platform } = {}) {
  if (platform === 'win32') {
    // The owner and its clients may spell the same folder differently (8.3 short
    // names, case), so key the pipe by the folder's real, case-folded path.
    let canonical = path.win32.resolve(root);
    try { canonical = realpathSync.native(canonical); } catch { /* not created yet, or another platform's path */ }
    const key = createHash('sha256').update(canonical.toLowerCase()).digest('hex');
    return `\\\\.\\pipe\\job-search-harness-${key.slice(0, 24)}`;
  }
  return path.posix.join(root, 'broker.sock');
}

/** Where clients connect: JOBDESK_SOCKET overrides it for clients only. */
export function clientEndpoint({ env = process.env, platform = process.platform } = {}) {
  return env.JOBDESK_SOCKET || brokerEndpoint(defaultDataRoot({ env, platform }), { platform });
}

/** The system command that opens a URL in the default browser, without a shell. */
export function browserCommand(url, platform = process.platform) {
  if (platform === 'darwin') return ['/usr/bin/open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}
