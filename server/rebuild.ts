// Settings → System → Rebuild and restart.
// The old dist is removed first, then `pnpm build` writes a new one.
// The caller restarts the daemon only after this resolves.
import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);

const BUILD_OPTS = { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 };

/** Remove `dist`, then build the web UI in `root`. A failed build rejects after dist is already gone. */
export async function rebuildWeb(root: string, dist: string): Promise<void> {
  const rootDir = resolve(root);
  const distDir = resolve(dist);
  // Only the project's own dist directory. A bad path must not become a recursive delete.
  if (distDir !== join(rootDir, 'dist')) throw new Error(`refusing to remove ${distDir}`);
  await rm(distDir, { recursive: true, force: true });
  await runBuild(rootDir);
}

async function runBuild(root: string): Promise<void> {
  try {
    await exec('pnpm', ['build'], { ...BUILD_OPTS, cwd: root });
  } catch (err) {
    // systemd's PATH includes /usr/bin, where pnpm lives. Fall back to the
    // checkout's vite when it doesn't, so the button still builds the UI.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await exec(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { ...BUILD_OPTS, cwd: root });
  }
}

/** Tail of a failed build, short enough to show in the confirm dialog. */
export function rebuildFailure(err: unknown): string {
  const e = err as { stdout?: unknown; stderr?: unknown; message?: string };
  const text = (v: unknown) => (v == null ? '' : String(v));
  const detail = `${text(e.stdout)}\n${text(e.stderr)}`.trim();
  const tail = detail.slice(-800).trim();
  return tail || e.message || 'build failed';
}
