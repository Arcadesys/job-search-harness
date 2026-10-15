import assert from 'node:assert/strict';
import test from 'node:test';
import { browserCommand, brokerEndpoint, clientEndpoint, defaultDataRoot, legacyRoots, isMainModule } from './paths.mjs';
import { inSyncedFolder } from './store';
import { writeFile, realpath, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempRoot } from '../../tests/fixtures/temp-root';

const none = () => false;

test('entry guards recognize symlinked install paths without running imported modules', { skip: process.platform === 'win32' }, async () => {
  const root = await tempRoot('jobdesk-entry-');
  try {
    const target = path.join(root, 'target.mjs'), alias = path.join(root, 'alias.mjs');
    await writeFile(target, '');
    await symlink(target, alias);
    const url = pathToFileURL(await realpath(target)).href;
    assert.equal(isMainModule(url, target), true);
    assert.equal(isMainModule(url, alias), true);
    assert.equal(isMainModule(import.meta.url, alias), false);
    assert.equal(isMainModule(url, ''), false);
    assert.equal(isMainModule(url, path.join(root, 'missing')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('each platform gets a per-user, unsynced data folder', () => {
  assert.equal(defaultDataRoot({ platform: 'darwin', env: {}, home: '/Users/sam', exists: none }),
    '/Users/sam/Library/Application Support/Job Search Harness');
  assert.equal(defaultDataRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Sam\\AppData\\Local' }, home: 'C:\\Users\\Sam', exists: none }),
    'C:\\Users\\Sam\\AppData\\Local\\Job Search Harness');
  assert.equal(defaultDataRoot({ platform: 'win32', env: {}, home: 'C:\\Users\\Sam', exists: none }),
    'C:\\Users\\Sam\\AppData\\Local\\Job Search Harness', 'falls back to the local, never roaming, profile');
  assert.equal(defaultDataRoot({ platform: 'linux', env: {}, home: '/home/sam', exists: none }),
    '/home/sam/.local/share/job-search-harness');
  assert.equal(defaultDataRoot({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, home: '/home/sam', exists: none }),
    '/data/job-search-harness');
  assert.equal(defaultDataRoot({ platform: 'darwin', env: { JOBDESK_DATA_DIR: '/private/jd' }, home: '/Users/sam', exists: none }), '/private/jd');
});

test('an existing folder from an earlier release is reused, but never preferred over a current one', () => {
  const [legacy] = legacyRoots({ platform: 'darwin', home: '/Users/sam' });
  const current = '/Users/sam/Library/Application Support/Job Search Harness';
  assert.equal(defaultDataRoot({ platform: 'darwin', env: {}, home: '/Users/sam', exists: (p) => p === legacy }), legacy);
  assert.equal(defaultDataRoot({ platform: 'darwin', env: {}, home: '/Users/sam', exists: (p) => p === legacy || p === current }), current);
  assert.deepEqual(legacyRoots({ platform: 'win32', home: 'C:\\Users\\Sam' }), []);
});

test('the broker is a socket in the data folder, or a Windows named pipe keyed by it', () => {
  assert.equal(brokerEndpoint('/Users/sam/Library/Application Support/Job Search Harness', { platform: 'darwin' }),
    '/Users/sam/Library/Application Support/Job Search Harness/broker.sock');
  const pipe = brokerEndpoint('C:\\Users\\Sam\\AppData\\Local\\Job Search Harness', { platform: 'win32' });
  assert.match(pipe, /^\\\\\.\\pipe\\job-search-harness-[a-f0-9]{24}$/);
  assert.equal(brokerEndpoint('c:\\users\\sam\\appdata\\local\\job search harness', { platform: 'win32' }), pipe,
    'Windows paths are case-insensitive, so the owner and its clients agree');
  assert.notEqual(brokerEndpoint('D:\\Other', { platform: 'win32' }), pipe);
  assert.equal(clientEndpoint({ platform: 'darwin', env: { JOBDESK_SOCKET: '/tmp/x.sock' } }), '/tmp/x.sock');
});

test('synced folders are refused on every platform', () => {
  for (const candidate of [
    '/Users/sam/Library/Mobile Documents/com~apple~CloudDocs/jd',
    '/Users/sam/Library/CloudStorage/GoogleDrive-sam/jd',
    '/Users/sam/Dropbox/jd',
    'C:\\Users\\Sam\\OneDrive - Contoso\\jd',
    'C:\\Users\\Sam\\OneDrive\\jd',
    'C:\\Users\\Sam\\iCloudDrive\\jd',
    'G:\\Google Drive\\jd',
  ]) assert.equal(inSyncedFolder(candidate), true, candidate);
  for (const candidate of ['/Users/sam/Library/Application Support/Job Search Harness', 'C:\\Users\\Sam\\AppData\\Local\\Job Search Harness'])
    assert.equal(inSyncedFolder(candidate), false, candidate);
});

test('the open command uses each platform’s own browser launcher, never a shell', () => {
  const url = 'http://127.0.0.1:4317/#ticket=abc_DEF-123';
  assert.deepEqual(browserCommand(url, 'darwin'), ['/usr/bin/open', [url]]);
  assert.deepEqual(browserCommand(url, 'win32'), ['rundll32', ['url.dll,FileProtocolHandler', url]]);
  assert.deepEqual(browserCommand(url, 'linux'), ['xdg-open', [url]]);
});

test('on Windows, every spelling of the data folder reaches the same pipe', { skip: process.platform !== 'win32' }, async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'jsh-pipe-'));
  try {
    const pipe = brokerEndpoint(root);
    assert.equal(brokerEndpoint(realpathSync.native(root)), pipe, 'short (8.3) and long names agree');
    assert.equal(brokerEndpoint(root.toUpperCase()), pipe, 'case does not matter');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
