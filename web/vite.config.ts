import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const server = process.env.OFFICE_SERVER ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@office/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      '/api': server,
      '/avatars': server,
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
});
