import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = `http://127.0.0.1:${process.env.AH_PORT ?? 7681}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/ws': { target: api, ws: true, changeOrigin: false },
    },
  },
});
