#!/usr/bin/env node
// The repository's stable `ah` entry point. The CLI lives in apps/server/bin/ah.js; this one
// stays where installs made before the move expect it: contrib/ah.service runs
// `node bin/ah.js serve` from the repository root, and `pnpm link --global` linked it here.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The page used to be built into ./dist; the server now serves apps/server/dist. A checkout
// that was pulled across the move and restarted without `pnpm build` has none there yet:
// build it once (the root build links the workspace's dependencies first), rather than
// serve "UI not built". A failed build still starts the server; its banner says why.
const [cmd = 'serve'] = process.argv.slice(2);
const root = fileURLToPath(new URL('..', import.meta.url));
if ((cmd === 'serve' || cmd.startsWith('--')) && !process.env.AH_DIST && !existsSync(`${root}apps/server/dist/index.html`)) {
  console.log('ah: the page has no build in apps/server/dist yet: running `pnpm build` once');
  const built = spawnSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) console.error(`ah: pnpm build failed (${built.error?.message ?? `exit ${built.status}`}); serving without the page`);
}
await import('../apps/server/bin/ah.js');
