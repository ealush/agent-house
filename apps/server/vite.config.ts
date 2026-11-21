import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * The page's one blocking script (the theme, set before the first paint) as a hashed asset:
 * /assets is cached for a year, so a launch reads it from the cache instead of asking the
 * host for it (a round trip over Tailscale, ahead of everything else). In dev it's served
 * from web/ as is.
 */
function themeBoot(): Plugin {
  const source = readFileSync(new URL('./web/theme-boot.js', import.meta.url), 'utf8');
  const fileName = `assets/theme-boot-${createHash('sha256').update(source).digest('hex').slice(0, 10)}.js`;
  return {
    name: 'ah-theme-boot',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName, source });
    },
    // Before Vite reads the page, so it doesn't try (and warn) to bundle a classic script.
    transformIndexHtml: { order: 'pre', handler: (html) => html.replace('src="/theme-boot.js"', `src="/${fileName}" vite-ignore`) },
  };
}

const api = `http://127.0.0.1:${process.env.AH_PORT ?? 7681}`;

export default defineConfig({
  root: 'web',
  plugins: [react(), themeBoot()],
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
