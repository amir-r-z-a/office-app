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
await app.listen({ port, host });

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => `http://${a!.address}:${port}`);
console.log(`\n  Office server is running.\n`);
console.log(`  On this computer:  http://localhost:${port}`);
for (const a of addresses) console.log(`  On the office Wi-Fi: ${a}`);
console.log(`\n  Data is kept in ${dataDir}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
