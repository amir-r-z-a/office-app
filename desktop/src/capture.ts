import { BrowserWindow, desktopCapturer, ipcMain, session, shell, systemPreferences, type DesktopCapturerSource } from 'electron';

// What the app shares when the page asks for getDisplayMedia(). The page first shows its own
// picker (screens and windows with live thumbnails), tells us the choice, then asks; the
// handler below answers with exactly that.

export interface SourceInfo {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string;
  icon: string | null;
}

/** `system`: everything the computer plays. `player`: only the built-in web player. */
export type AudioChoice = 'none' | 'system' | 'player';

interface Choice {
  sourceId: string | null;
  audio: AudioChoice;
}

let pending: Choice | null = null;
let player: BrowserWindow | null = null;
let notifyPlayerClosed: () => void = () => undefined;

export function setupCapture(getMainWindow: () => BrowserWindow | null) {
  notifyPlayerClosed = () => getMainWindow()?.webContents.send('office:player-closed');

  // macOS only lets an app see other windows with Screen Recording permission. Asking for
  // sources without it pops the system prompt, so the page checks this first.
  ipcMain.handle('office:capture:access', () =>
    process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
  );
  ipcMain.on('office:capture:settings', () => {
    if (process.platform === 'darwin') void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  });

  ipcMain.handle('office:capture:sources', async (_e, opts: { width?: number; height?: number } = {}): Promise<SourceInfo[]> => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: opts.width ?? 400, height: opts.height ?? 250 },
      fetchWindowIcons: true,
    });
    // The player is shared through "Web player", not as a window.
    const playerId = player && !player.isDestroyed() ? player.getMediaSourceId() : null;
    return sources
      .filter((s) => s.id !== playerId)
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      }));
  });

  ipcMain.on('office:capture:choose', (_e, choice: Choice) => {
    pending = choice;
  });

  ipcMain.handle('office:player:open', (_e, url: string) => openPlayer(url));
  ipcMain.on('office:player:close', () => player?.close());

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const choice = pending;
    pending = null;
    try {
      if (choice?.audio === 'player') {
        if (!player || player.isDestroyed()) return callback({});
        // Only the player's own sound, and keep playing it for the person sharing.
        const frame = player.webContents.mainFrame;
        return callback({ video: frame, audio: frame, enableLocalEcho: true });
      }
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source: DesktopCapturerSource | undefined = choice?.sourceId
        ? sources.find((s) => s.id === choice.sourceId)
        : sources.find((s) => s.id.startsWith('screen:'));
      if (!source) return callback({});
      const wantsAudio = request.audioRequested && choice?.audio !== 'none';
      callback(wantsAudio ? { video: source, audio: 'loopback' } : { video: source });
    } catch {
      callback({});
    }
  });
}

/** A small browser window inside Office whose sound, and only its sound, can be shared. */
async function openPlayer(url: string): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return false;
  }
  if (player && !player.isDestroyed()) {
    await player.loadURL(target.href);
    player.show();
    player.focus();
    return true;
  }
  player = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 480,
    minHeight: 360,
    title: 'Office Player',
    autoHideMenuBar: true,
    backgroundColor: '#0c0b14',
    webPreferences: { partition: 'persist:office-player', contextIsolation: true, sandbox: true },
  });
  // Present as plain Chrome so sites serve their normal player.
  const ua = player.webContents.getUserAgent().replace(/ Electron\/\S+/, '').replace(/ Office\/\S+/, '');
  player.webContents.setUserAgent(ua);
  // Links that open new windows stay in the player.
  player.webContents.setWindowOpenHandler(({ url: next }) => {
    void player?.loadURL(next);
    return { action: 'deny' };
  });
  player.webContents.on('page-title-updated', (_e, title) => player?.setTitle(`${title} · Office Player`));
  player.on('closed', () => {
    player = null;
    notifyPlayerClosed();
  });
  await player.loadURL(target.href);
  return true;
}
