import { contextBridge, ipcRenderer } from 'electron';

// The small bridge the office web app uses when it runs inside the desktop app.
contextBridge.exposeInMainWorld('officeDesktop', {
  platform: process.platform,
  connect: (server: string) => ipcRenderer.invoke('office:connect', server) as Promise<{ ok: boolean; error?: string }>,
  changeServer: () => ipcRenderer.send('office:change-server'),
  attention: () => ipcRenderer.send('office:attention'),
  updates: {
    get: () => ipcRenderer.invoke('office:update:get'),
    check: () => ipcRenderer.invoke('office:update:check'),
    install: () => ipcRenderer.send('office:update:install'),
    openDownloadPage: () => ipcRenderer.send('office:update:download-page'),
    onChange: (fn: (state: unknown) => void) => {
      const listener = (_e: unknown, state: unknown) => fn(state);
      ipcRenderer.on('office:update', listener);
      return () => ipcRenderer.removeListener('office:update', listener);
    },
  },
});
