import { app, BrowserWindow, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Config {
  server: string | null;
}

const configFile = join(app.getPath('userData'), 'config.json');
const staticDir = join(__dirname, '..', 'static');
let config: Config = readConfig();
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function readConfig(): Config {
  try {
    return existsSync(configFile) ? (JSON.parse(readFileSync(configFile, 'utf8')) as Config) : { server: null };
  } catch {
    return { server: null };
  }
}

function saveConfig(next: Config) {
  config = next;
  writeFileSync(configFile, JSON.stringify(next, null, 2));
}

// The office server speaks plain HTTP on the LAN. Chromium only allows the microphone on
// secure origins, so the configured server is treated as one. This must be set before ready.
if (config.server) app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', config.server);
app.setAppUserModelId('app.office.desktop');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start);
}

function start() {
  // Only the office server gets the mic, camera, screen and notifications.
  session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
    const fromServer = !!config.server && wc.getURL().startsWith(config.server);
    done(fromServer && ['media', 'notifications', 'display-capture', 'clipboard-sanitized-write'].includes(permission));
  });

  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Office',
    backgroundColor: '#0c0b14',
    icon: join(staticDir, 'icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win?.show());

  // Closing the window keeps the app in the tray, so doorbells still ring.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
  });

  // Links to other sites open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    if (config.server && url.startsWith(config.server)) showConnect(`Couldn’t reach ${config.server} (${description || code}).`);
  });

  createTray();
  if (config.server) void win.loadURL(config.server);
  else showConnect();
}

function showConnect(error?: string) {
  void win?.loadFile(join(staticDir, 'connect.html'), {
    query: { server: config.server ?? '', error: error ?? '' },
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const image = nativeImage.createFromPath(join(staticDir, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  tray = new Tray(image);
  tray.setToolTip('Office');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Office', click: showWindow },
      { label: 'Change server…', click: () => (showWindow(), showConnect()) },
      { type: 'separator' },
      { label: 'Start when I sign in', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
      { type: 'separator' },
      { label: 'Quit', click: () => ((quitting = true), app.quit()) },
    ]),
  );
  tray.on('click', showWindow);
}

ipcMain.handle('office:connect', async (_e, raw: string) => {
  const server = normalize(raw);
  if (!server) return { ok: false, error: 'That doesn’t look like an address. Try something like 192.168.1.20:4000.' };
  try {
    const res = await fetch(`${server}/api/setup`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(String(res.status));
    await res.json();
  } catch {
    return { ok: false, error: `No office server answered at ${server}. Check the address and that you’re on the office Wi-Fi.` };
  }
  const changed = server !== config.server;
  saveConfig({ server });
  if (changed) {
    // The secure-origin switch only applies at launch, so restart into the new server.
    app.relaunch();
    quitting = true;
    app.exit(0);
  } else {
    void win?.loadURL(server);
  }
  return { ok: true };
});

ipcMain.on('office:change-server', () => showConnect());
ipcMain.on('office:attention', () => {
  // A doorbell while the window is hidden or in the background: bring it forward.
  if (!win) return;
  if (!win.isVisible() || win.isMinimized()) showWindow();
  else if (!win.isFocused()) win.flashFrame(true);
});

function normalize(raw: string): string | null {
  let s = raw.trim().replace(/\/+$/, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const url = new URL(s);
    if (!url.port && url.protocol === 'http:') url.port = '4000';
    return url.origin;
  } catch {
    return null;
  }
}

app.on('before-quit', () => (quitting = true));
app.on('activate', showWindow);
