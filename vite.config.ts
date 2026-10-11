import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = `http://127.0.0.1:${process.env.AH_PORT ?? 7681}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    // The CSP allows fonts from 'self' only: a small font inlined as data: is blocked.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
  server: {
    host: '127.0.0.1',
    // Anchored: a bare '/api' prefix also matches the page's own /api.ts module.
    proxy: {
      '^/api/': { target: api, changeOrigin: false },
      '^/ws/': { target: api, ws: true, changeOrigin: false },
    },
  },
});
