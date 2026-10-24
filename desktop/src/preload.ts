import { contextBridge, ipcRenderer } from 'electron';

// The small bridge the office web app uses when it runs inside the desktop app.
contextBridge.exposeInMainWorld('officeDesktop', {
  platform: process.platform,
  connect: (server: string) => ipcRenderer.invoke('office:connect', server) as Promise<{ ok: boolean; error?: string }>,
  changeServer: () => ipcRenderer.send('office:change-server'),
  attention: () => ipcRenderer.send('office:attention'),
});
