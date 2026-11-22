// Where a moved session works on the destination. Machines don't share absolute
// paths (/home/me/code/x on Linux is /Users/me/code/x on a Mac, or elsewhere
// entirely), so the destination looks, in order: a folder you named; the
// configured path map (`migration.pathMap`); the same path; the same place under
// home; and a checkout of the same repository (by its origin URL) under the
// project roots. The first that exists wins, and the answer says which. Only folders
// inside this host's project and file roots qualify: another host chooses nothing
// outside them.
import { readdir, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import type { Manifest, Preflight } from './manifest.ts';

export type PathRule = { from: string; to: string };

export type ResolveDeps = {
  home: string;
  roots: string[];
  rules: PathRule[];
  remoteOf: (dir: string) => Promise<string | null>;
};

const isDir = async (p: string) => !!(await stat(p).catch(() => null))?.isDirectory();
const inside = (p: string, roots: string[]) => roots.some((r) => p === r || p.startsWith(r.replace(/\/?$/, '/')));

/** Strips a remote to compare it: scheme, credentials, `.git`, case of the host. */
export function sameRemote(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (u: string) =>
    u
      .trim()
      .replace(/^git@([^:]+):/, 'https://$1/')
      .replace(/^ssh:\/\/git@/, 'https://')
      .replace(/^https?:\/\/[^@/]*@/, 'https://')
      .replace(/\.git$/, '')
      .replace(/\/$/, '')
      .toLowerCase();
  return norm(a) === norm(b);
}

/** Git checkouts up to two levels under each root (where projects usually live). */
/** `<dir>/.worktrees/<repo>/<name>[/sub]` → `<dir>/<repo>[/sub]`; null for any other path. */
export function mainCheckoutOf(path: string): string | null {
  const m = path.match(/^(.*)\/\.worktrees\/([^/]+)\/[^/]+(\/.*)?$/);
  return m ? `${m[1]}/${m[2]}${m[3] ?? ''}` : null;
}

async function checkouts(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    const level = async (dir: string, depth: number) => {
      if (out.length > 400) return;
      if (await stat(join(dir, '.git')).catch(() => null)) out.push(dir);
      if (depth === 0) return;
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') await level(join(dir, e.name), depth - 1);
      }
    };
    await level(root, 2);
  }
  return out;
}

export async function resolveDestination(m: Manifest, explicit: string | null, deps: ResolveDeps): Promise<{ cwd: string | null; by: Preflight['resolvedBy']; repoRoot: string | null }> {
  const ok = async (p: string) => inside(p, deps.roots) && (await isDir(p));
  if (explicit) return (await ok(explicit)) ? { cwd: explicit, by: 'explicit', repoRoot: null } : { cwd: null, by: null, repoRoot: null };
  // A session in one of ah's worktrees (`<dir>/.worktrees/<repo>/<name>`, server/git.ts) has none
  // on the destination: its repository's own checkout (`<dir>/<repo>`) is the next best place.
  const sources = [m.session.cwd, ...(m.project.worktree ? [mainCheckoutOf(m.session.cwd)].filter((p): p is string => !!p) : [])];
  for (const src of sources) {
    for (const r of deps.rules) {
      if (!r.from || !r.to || !(src === r.from || src.startsWith(r.from.replace(/\/?$/, '/')))) continue;
      const mapped = join(r.to, relative(r.from, src));
      if (await ok(mapped)) return { cwd: mapped, by: 'path_map', repoRoot: null };
    }
    if (await ok(src)) return { cwd: src, by: 'same_path', repoRoot: null };
    const rel = relative(m.from.home, src);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      const mapped = join(deps.home, rel);
      if (await ok(mapped)) return { cwd: mapped, by: 'home_relative', repoRoot: null };
    }
  }
  if (m.project.remote) {
    for (const dir of await checkouts(deps.roots)) {
      if (!sameRemote(await deps.remoteOf(dir), m.project.remote)) continue;
      const sub = m.project.rel && m.project.rel !== '.' ? join(dir, m.project.rel) : dir;
      return { cwd: (await isDir(sub)) ? sub : dir, by: 'git_remote', repoRoot: dir };
    }
  }
  return { cwd: null, by: null, repoRoot: null };
}
