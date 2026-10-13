import assert from 'node:assert/strict';
import test from 'node:test';
import { browserCommand, brokerEndpoint, clientEndpoint, defaultDataRoot, legacyRoots } from './paths.mjs';
import { inSyncedFolder } from './store';

const none = () => false;

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
