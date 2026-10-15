import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from 'electron';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { brokerCall } from '../services/jobdesk/client';
import { brokerEndpoint, defaultDataRoot } from '../services/jobdesk/paths.mjs';

/** The desktop app: owns the private jobdesk, shows the cockpit in its own window, and stays
 * in the tray so the user's assistant can reach it. Nothing here talks to the network. */
const background = process.argv.includes('--background');
const smoke = process.env.JOBDESK_SMOKE === '1';
const MCP_FILES = ['mcp-server.mjs', 'mcp-client.mjs', 'paths.mjs', 'workflow-tools.mjs'];

process.env.JOBDESK_RESOURCES ??= app.getAppPath();
const dataRoot = defaultDataRoot();
// Keep Chromium's own caches beside, not inside, the private data folder.
app.setPath('userData', path.join(path.dirname(dataRoot), `${path.basename(dataRoot)} (app)`));

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: Awaited<ReturnType<typeof import('../services/jobdesk/server').startJobdesk>> | null = null;
let socketPath = brokerEndpoint(dataRoot);
let quitting = false;

/** A command that keeps working after updates: AppImages remount at a new path each run. */
function appCommand() {
  return process.env.APPIMAGE || process.execPath;
}
/** An unpackaged run (development, tests) must also name the app folder. A sandbox opt-out
 * the user started with (root containers) carries over to background launches. */
function appArgs() {
  return [...(app.isPackaged ? [] : [app.getAppPath()]), ...process.argv.filter((arg) => arg === '--no-sandbox')];
}

/** Assistants launch the MCP adapter with the app's own runtime, from a stable copy of its
 * dependency-free scripts, so no separate Node.js install is needed. */
async function prepareMcp() {
  const target = path.join(app.getPath('userData'), 'mcp', app.getVersion());
  await mkdir(target, { recursive: true });
  for (const name of MCP_FILES) await cp(path.join(app.getAppPath(), 'services', 'jobdesk', name), path.join(target, name));
  for (const old of await readdir(path.dirname(target)))
    if (old !== app.getVersion()) await rm(path.join(path.dirname(target), old), { recursive: true, force: true });
  process.env.JOBDESK_MCP_LAUNCH = JSON.stringify({
    command: appCommand(),
    args: [path.join(target, 'mcp-server.mjs')],
    env: { ELECTRON_RUN_AS_NODE: '1', JOBDESK_APP: appCommand(), ...(appArgs().length ? { JOBDESK_APP_ARGS: JSON.stringify(appArgs()) } : {}), ...(process.env.JOBDESK_DATA_DIR ? { JOBDESK_DATA_DIR: dataRoot } : {}) },
  });
}

/** The earlier macOS installer ran the owner from a LaunchAgent. Stop that one service by its
 * exact label, keep its plist as a .retired copy, and let this app own the same data folder.
 * Its MCP entry is repaired to point here by repairConnections. */
const LEGACY_AGENT = 'me.thearcades.job-search-harness';
async function retireMacInstaller() {
  if (process.platform !== 'darwin') return;
  const plist = path.join(homedir(), 'Library', 'LaunchAgents', `${LEGACY_AGENT}.plist`);
  const text = await readFile(plist, 'utf8').catch(() => '');
  if (!text.includes(`<string>${LEGACY_AGENT}</string>`)) return;
  spawnSync('/bin/launchctl', ['bootout', `gui/${process.getuid?.()}`, plist], { stdio: 'ignore' });
  for (let tries = 0; tries < 40 && await brokerCall('health', [], socketPath).then(() => true, () => false); tries++)
    await new Promise((resolve) => setTimeout(resolve, 250));
  await rename(plist, `${plist}.retired`);
}

async function startOwner() {
  const { startJobdesk } = await import('../services/jobdesk/server');
  const { recoverOwnerLock } = await import('../services/jobdesk/store');
  const start = () => startJobdesk({ root: dataRoot, onShutdownRequest: () => void quit() });
  try {
    runtime = await start();
  } catch (error) {
    // A background owner started from the command line already holds the database: use it.
    const running = await brokerCall('health', [], socketPath).then(() => true, () => false);
    if (!running) {
      // After a force quit or power loss the lock outlives its process. Recovery proves the
      // old process is gone before removing it, and never touches leases or submissions.
      await recoverOwnerLock(dataRoot).catch(() => { throw error; });
      runtime = await start();
    }
  }
  if (runtime) socketPath = runtime.socketPath;
  const { repairConnections } = await import('../services/jobdesk/assistants');
  await repairConnections().catch(() => undefined);
}

/** Every window load gets a fresh one-time ticket, so long-running sessions never expire on screen. */
async function showCockpit() {
  const { url } = await brokerCall('browser.open', [], socketPath);
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({
      width: 1440, height: 960, minWidth: 380, minHeight: 500, show: false, backgroundColor: '#10131d',
      title: 'Job Search Harness', autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: process.platform !== 'linux' },
    });
    const origin = new URL(url).origin;
    const external = (target: string) => { if (/^https?:/.test(target)) void shell.openExternal(target); };
    window.webContents.setWindowOpenHandler(({ url: target }) => { external(target); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, target) => {
      if (new URL(target).origin !== origin) { event.preventDefault(); external(target); }
    });
    // macOS and Windows keep running in the menu bar or tray. Some Linux desktops hide tray
    // icons, so there closing quits; the assistant's MCP adapter restarts the app when needed.
    window.on('close', (event) => {
      if (quitting || process.platform === 'linux' || !tray) return;
      event.preventDefault();
      window?.hide();
    });
    window.once('ready-to-show', () => window?.show());
  }
  await window.loadURL(url);
  window.show();
  window.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icons', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Job Search Harness is running');
  const loginItems = process.platform === 'darwin' || process.platform === 'win32';
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open Job Search Harness', click: () => void showCockpit() },
    ...(loginItems ? [{ label: 'Start when I sign in', type: 'checkbox' as const, checked: app.getLoginItemSettings().openAtLogin,
      click: (item: Electron.MenuItem) => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--background'] }); } }] : []),
    { type: 'separator' },
    { label: 'Quit Job Search Harness', click: () => void quit() },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', () => void showCockpit());
}

async function quit() {
  if (quitting) return;
  quitting = true;
  try { await runtime?.close(); } finally { app.exit(0); }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => { if (!argv.includes('--background')) void showCockpit(); });
  app.on('activate', () => void showCockpit());
  app.on('window-all-closed', () => { if (!tray || process.platform === 'linux') void quit(); });
  app.on('before-quit', (event) => { if (!quitting) { event.preventDefault(); void quit(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]) : null);
    await prepareMcp();
    await retireMacInstaller().catch(() => undefined);
    await startOwner();
    if (!smoke) createTray();
    if (!background) await showCockpit();
  }).catch((error) => {
    dialog.showErrorBox('Job Search Harness could not start',
      `${error instanceof Error ? error.message : 'Unknown error.'}\n\nYour data is unchanged in ${dataRoot}.`);
    app.exit(1);
  });
}
