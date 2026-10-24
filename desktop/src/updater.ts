import { app, shell } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { autoUpdater } from 'electron-updater';

// Updates come from the GitHub releases of the repo. On Windows the standard electron-updater
// installs them. On macOS the app isn't signed with an Apple Developer ID, and Apple's updater
// refuses unsigned apps, so the new version is downloaded and swapped in place on restart.

export type UpdateStatus = 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error' | 'unsupported';

export interface UpdateState {
  status: UpdateStatus;
  current: string;
  version?: string;
  progress?: number;
  error?: string;
  /** Somewhere the person can download the new version by hand, when updating in place fails. */
  manualUrl?: string;
}

const OWNER = 'amir-r-z-a';
const REPO = 'office-app';
const RELEASES = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const run = promisify(execFile);

type Listener = (state: UpdateState) => void;

class Updater {
  state: UpdateState = { status: 'idle', current: app.getVersion() };
  private listeners = new Set<Listener>();
  private macReadyApp: string | null = null;
  private busy = false;
  private beforeQuit: () => void = () => undefined;

  /** `beforeQuit` lets the window close for real instead of hiding to the tray. */
  start(beforeQuit: () => void) {
    this.beforeQuit = beforeQuit;
    if (!app.isPackaged) {
      this.set({ status: 'unsupported', error: 'Updates only work in the installed app.' });
      return;
    }
    if (process.platform === 'win32') this.setupWindows();
    setTimeout(() => void this.check(), 15_000);
    setInterval(() => void this.check(), CHECK_EVERY_MS).unref();
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  async check(): Promise<void> {
    if (!app.isPackaged || this.busy || this.state.status === 'ready') return;
    if (process.platform === 'win32') {
      this.set({ status: 'checking', error: undefined });
      await autoUpdater.checkForUpdates().catch((err: Error) => this.set({ status: 'error', error: friendly(err) }));
    } else if (process.platform === 'darwin') {
      await this.checkMac();
    } else {
      this.set({ status: 'unsupported' });
    }
  }

  install() {
    if (this.state.status !== 'ready') return;
    if (process.platform === 'win32') {
      this.beforeQuit();
      // Silent install, then start the new version.
      autoUpdater.quitAndInstall(true, true);
    } else if (process.platform === 'darwin') {
      this.installMac();
    }
  }

  // Windows

  private setupWindows() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'none' }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, progress: 0 }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', progress: p.percent / 100 }));
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version, progress: 1 }));
    autoUpdater.on('error', (err) => this.set({ status: 'error', error: friendly(err), manualUrl: RELEASES }));
  }

  // macOS

  private async checkMac() {
    this.busy = true;
    this.set({ status: 'checking', error: undefined });
    try {
      const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'Office-desktop' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(res.status === 404 ? 'No releases published yet.' : `GitHub answered ${res.status}.`);
      const release = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string; size: number }[] };
      const version = release.tag_name.replace(/^v/, '');
      if (!isNewer(version, app.getVersion())) {
        this.set({ status: 'none', version: undefined });
        return;
      }
      const asset = release.assets.find((a) => a.name.endsWith('-mac.zip'));
      if (!asset) throw new Error('This release has no Mac download yet.');
      this.set({ status: 'downloading', version, progress: 0, manualUrl: RELEASES });

      const dir = mkdtempSync(join(tmpdir(), 'office-update-'));
      const zip = join(dir, asset.name);
      const download = await fetch(asset.browser_download_url, { headers: { 'user-agent': 'Office-desktop' } });
      if (!download.ok || !download.body) throw new Error(`Download failed (${download.status}).`);
      const total = Number(download.headers.get('content-length')) || asset.size;
      let received = 0;
      const body = Readable.fromWeb(download.body as Parameters<typeof Readable.fromWeb>[0]);
      body.on('data', (chunk: Buffer) => {
        received += chunk.length;
        // Report about every 2%, not on every chunk.
        const progress = total ? received / total : 0;
        if (progress - (this.state.progress ?? 0) > 0.02) this.set({ progress });
      });
      await pipeline(body, createWriteStream(zip));

      const unpacked = join(dir, 'app');
      await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
      const bundle = readdirSync(unpacked).find((f) => f.endsWith('.app'));
      if (!bundle) throw new Error('The download didn’t contain the app.');
      rmSync(zip, { force: true });
      this.macReadyApp = join(unpacked, bundle);
      this.set({ status: 'ready', progress: 1 });
    } catch (err) {
      this.set({ status: 'error', error: friendly(err as Error), manualUrl: RELEASES });
    } finally {
      this.busy = false;
    }
  }

  private installMac() {
    const next = this.macReadyApp;
    // .../Office.app/Contents/MacOS/Office -> .../Office.app
    const current = dirname(dirname(dirname(app.getPath('exe'))));
    if (!next || !existsSync(next) || !current.endsWith('.app')) return;
    if (current.startsWith('/Volumes/')) {
      this.set({ status: 'error', error: 'Drag Office into your Applications folder first, then update from there.' });
      return;
    }
    try {
      accessSync(dirname(current), constants.W_OK);
    } catch {
      this.set({ status: 'error', error: 'Office can’t replace itself in this folder. Download the new version instead.', manualUrl: RELEASES });
      return;
    }
    // A small script waits for this app to quit, swaps the bundle (keeping the old one until the
    // copy succeeds), and opens the new version.
    const script = join(dirname(next), 'swap.sh');
    writeFileSync(
      script,
      `#!/bin/sh
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
OLD="${current}.updating-old"
rm -rf "$OLD"
if mv "${current}" "$OLD" && /usr/bin/ditto "${next}" "${current}"; then
  rm -rf "$OLD"
else
  rm -rf "${current}"
  mv "$OLD" "${current}"
fi
/usr/bin/xattr -dr com.apple.quarantine "${current}" 2>/dev/null
/usr/bin/open "${current}"
`,
      { mode: 0o755 },
    );
    spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
    this.beforeQuit();
    app.quit();
  }

  openDownloadPage() {
    void shell.openExternal(this.state.manualUrl ?? RELEASES);
  }
}

/** True when `a` is a later version than `b` (both like 1.2.3). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

function friendly(err: Error): string {
  const msg = err?.message ?? String(err);
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network|fetch failed|aborted/i.test(msg)) return 'Couldn’t reach GitHub to check for updates. Is this computer online?';
  return msg.split('\n')[0].slice(0, 200);
}

export const updater = new Updater();
