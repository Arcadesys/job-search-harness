import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
let window;
let opening;

app.setName('Job Search Harness');
// Electron's window/session files are separate from the private jobdesk store.
app.setPath('userData', process.env.JOBDESK_DESKTOP_USER_DATA_DIR ??
  path.join(app.getPath('appData'), 'Job Search Harness Desktop'));

function openExternal(url) {
  try {
    const target = new URL(url);
    if (['https:', 'http:'].includes(target.protocol))
      void shell.openExternal(target.href);
  } catch { /* Invalid addresses never leave the sandbox. */ }
}

async function openWorkspace() {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  if (opening) return opening;
  opening = (async () => {
    const { stdout } = await execute(process.execPath,
      ['--import', 'tsx', path.join(app.getAppPath(), 'desktop/launch.ts')], {
        cwd: app.getAppPath(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', JOBDESK_PORT: process.env.JOBDESK_PORT ?? '0' },
        timeout: 40_000,
        maxBuffer: 100_000,
        windowsHide: true,
      });
    // A fresh one-use ticket stays in process memory, never in logs or argv.
    const { url } = JSON.parse(stdout);
    const target = new URL(url);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' ||
        !target.hash.startsWith('#ticket=')) throw new Error('Invalid local workspace address.');
    const origin = target.origin;
    window = new BrowserWindow({
      title: 'Job Search Harness',
      width: 1280,
      height: 900,
      minWidth: 390,
      minHeight: 480,
      backgroundColor: '#10131d',
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, zoomFactor: 1.25 },
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });
    const guardNavigation = (event, url) => {
      if (!url.startsWith(`${origin}/`)) {
        event.preventDefault();
        openExternal(url);
      }
    };
    window.webContents.on('will-navigate', guardNavigation);
    window.webContents.on('will-redirect', guardNavigation);
    window.once('ready-to-show', () => window?.show());
    window.on('closed', () => { window = undefined; });
    await window.loadURL(target.href);
  })().catch((error) => {
    if (window && !window.isDestroyed()) window.close();
    dialog.showErrorBox('Could not open Job Search Harness',
      `${error.stderr?.trim() || error.message}\n\nIf an owner lock needs recovery, use the documented jobdesk recovery procedure. Your private data has not been reset.`);
  }).finally(() => { opening = undefined; });
  return opening;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => void openWorkspace());
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { label: 'View', submenu: [
        { role: 'reload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ] },
      { role: 'windowMenu' },
    ]));
    await openWorkspace();
    app.on('activate', () => void openWorkspace());
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
