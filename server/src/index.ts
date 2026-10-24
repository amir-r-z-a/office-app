import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '0.0.0.0';
const dataDir = resolve(process.env.DATA_DIR ?? join(here, '..', 'data'));
const webDir = resolve(process.env.WEB_DIR ?? join(here, '..', '..', 'web', 'dist'));

const { app } = await buildApp({ dataDir, webDir, logger: process.env.LOG === '1' });
try {
  await app.listen({ port, host });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`\n  Port ${port} is already in use. Is the office server already running in another window?`);
    console.error(`  Stop that one first, or start this one on another port: PORT=4001 npm start\n`);
    process.exit(1);
  }
  throw err;
}

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => `http://${a!.address}:${port}`);
console.log(`\n  Office server is running.\n`);
console.log(`  On this computer:  http://localhost:${port}`);
for (const a of addresses) console.log(`  On the office Wi-Fi: ${a}`);
console.log(`\n  Data is kept in ${dataDir}\n`);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // A second Ctrl+C means "now".
    if (stopping) process.exit(0);
    stopping = true;
    console.log('\n  Stopping the office server…');
    // Never hang on a stuck connection: give up waiting after a few seconds.
    setTimeout(() => process.exit(0), 3000).unref();
    app.close().then(
      () => {
        console.log('  Stopped.\n');
        process.exit(0);
      },
      () => process.exit(0),
    );
  });
}
