// Start the desktop app for development.
//
// On macOS, an app launched from a terminal counts as part of the terminal, so permission
// prompts (microphone, screen and system audio recording) are asked for the terminal app,
// and system audio comes back silent. Opening Electron.app through Launch Services makes it
// its own app, so macOS asks for "Electron" and the capture works.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron'); // path to the Electron binary
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform === 'darwin') {
  const bundle = electron.slice(0, electron.indexOf('.app/') + 4);
  // -W waits until the app quits, so Ctrl+C in the terminal still feels normal.
  const child = spawn('open', ['-W', '-n', bundle, '--args', appDir], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  const child = spawn(electron, [appDir], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}
