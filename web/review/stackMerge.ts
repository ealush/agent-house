// What merging the whole stack would do, worked out on the page from each
// layer's gates; the host checks it all again (ReviewService.mergeStack).
import type { Layer, Stack } from '../reviewApi.ts';

export type Method = Stack['mergeMethod'];
/** A layer in the merge: it lands; it lands once marked reviewed; it's held (and why); or it waits behind one that is. */
export type MergeRow = { layer: Layer; state: 'ready' | 'review' | 'held' | 'waits' | 'restack'; why: string | null; step: number };
export type MergePlan = {
  rows: MergeRow[];
  /** The last layer that lands, or null when none can. */
  upTo: Layer | null;
  lands: Layer[];
  /** Layers you haven't marked reviewed at their current heads: merging marks them. */
  review: Layer[];
  /** What stops the merge short of the top, if anything. */
  stop: MergeRow | null;
};

const name = (l: Layer) => l.role || `#${l.pr}`;

/**
 * Bottom up: each open layer's gates, less those the merge itself takes care of
 * (merge order, the layers under it, targeting a layer merged before it) and
 * your review mark. The layers in one GitHub stack, next to each other in the
 * order, land in one step. Squash or rebase on a chain lands one step: what's
 * above it then needs a restack, which is the agent's to do.
 */
export function planStackMerge(stack: Stack, method: Method): MergePlan {
  const open = stack.layers.filter((l) => l.state === 'open');
  const rows: MergeRow[] = [];
  const heads = new Set<string>();
  let stop: MergeRow | null = null;
  let step = 0;
  for (let i = 0; i < open.length; i++) {
    const l = open[i];
    const prev = open[i - 1];
    if (!prev || l.ghStack === null || l.ghStack !== prev.ghStack || (l.ghPos ?? 0) < (prev.ghPos ?? 0)) step++;
    if (stop) {
      rows.push({ layer: l, state: 'waits', why: `Waits for ${name(stop.layer)}`, step });
      continue;
    }
    // Squash or rebase: a layer that sat on one an earlier step landed now repeats its commits,
    // unless GitHub moves it itself (the same GitHub stack).
    const sat = rows.some((r) => r.step < step && r.layer.headRef === l.baseRef && !(l.ghStack !== null && r.layer.ghStack === l.ghStack));
    if (method !== 'merge' && sat) {
      stop = { layer: l, state: 'restack', why: `Needs a restack once ${name(prev)} lands`, step };
      rows.push(stop);
      continue;
    }
    const bad = l.gates.find((g) => !g.ok && g.key !== 'order' && g.key !== 'below' && g.key !== 'reviewed' && !(g.key === 'base' && heads.has(l.baseRef)));
    if (bad) {
      stop = { layer: l, state: 'held', why: bad.detail ?? bad.label, step };
      rows.push(stop);
      continue;
    }
    const review = l.gates.some((g) => g.key === 'reviewed' && !g.ok);
    rows.push({ layer: l, state: review ? 'review' : 'ready', why: null, step });
    heads.add(l.headRef);
  }
  const lands = rows.filter((r) => r.state === 'ready' || r.state === 'review').map((r) => r.layer);
  return { rows, upTo: lands.at(-1) ?? null, lands, review: rows.filter((r) => r.state === 'review').map((r) => r.layer), stop };
}
