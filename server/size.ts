// Disk usage for worktree trees: a background, cached walker. Measuring a
// checkout can mean walking 100k files (node_modules), so the list path never
// measures inline; it serves the last cached value and kicks off a refresh.
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type DirSize = {
  /** Allocated bytes (stat.blocks * 512), falling back to logical where blocks are unavailable. Null when tooLarge. */
  sizeBytes: number | null;
  logicalBytes: number;
  /** Some entries could not be read; the totals are a lower bound. */
  partial: boolean;
  /** The walk hit the entry cap; no total is reported rather than a wrong one. */
  tooLarge: boolean;
  /** Seconds since epoch, when this measurement finished. */
  measuredAt: number;
};

const MAX_ENTRIES = 500_000;
const YIELD_EVERY = 2000;

/**
 * Sum a tree's size without following symlinks: a linked node_modules or a
 * shared store must not be counted twice or escape the tree, and not
 * following links makes loops impossible by construction.
 */
export async function measureDir(root: string, maxEntries = MAX_ENTRIES): Promise<DirSize> {
  let logical = 0;
  let allocated = 0;
  let entries = 0;
  let partial = false;
  let tooLarge = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      partial = true;
      continue;
    }
    for (const name of names) {
      if (++entries > maxEntries) {
        tooLarge = true;
        break;
      }
      // Yield periodically so a huge walk never starves the ticker or terminals.
      if (entries % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
      const p = join(dir, name);
      let st;
      try {
        st = await lstat(p);
      } catch {
        partial = true;
        continue;
      }
      logical += st.size;
      allocated += st.blocks != null ? st.blocks * 512 : st.size;
      if (st.isDirectory() && !st.isSymbolicLink()) stack.push(p);
    }
    if (tooLarge) break;
  }
  return { sizeBytes: tooLarge ? null : allocated, logicalBytes: logical, partial, tooLarge, measuredAt: Math.floor(Date.now() / 1000) };
}

// ---------- cache: one measurement per path, refreshed in the background

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { size: DirSize; rootMtimeMs: number }>();
const inflight = new Map<string, Promise<void>>();

export function cachedSize(path: string): DirSize | null {
  return cache.get(path)?.size ?? null;
}

/** Refresh the cached size for a path in the background, unless a fresh one exists. Never blocks the caller. */
export function requestSize(path: string): void {
  if (inflight.has(path)) return;
  const run = (async () => {
    try {
      const st = await lstat(path);
      const hit = cache.get(path);
      if (hit && hit.rootMtimeMs === st.mtimeMs && Date.now() - hit.size.measuredAt * 1000 < TTL_MS) return;
      const size = await measureDir(path);
      cache.set(path, { size, rootMtimeMs: st.mtimeMs });
    } catch {
      // Path gone or unreadable: keep any stale value rather than flapping to null.
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, run);
}

export function invalidateSize(path: string): void {
  cache.delete(path);
}

/** Test hook: wait for all background measurements to settle. */
export async function settleSizes(): Promise<void> {
  await Promise.all([...inflight.values()]);
}
