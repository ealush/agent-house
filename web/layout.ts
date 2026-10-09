// Binary split-layout model (F45). Each leaf is an independent viewer onto one
// tmux window — never tmux's own split-pane. Ratios (not pixels) are persisted,
// so a layout moves between a 32" monitor and an 11" iPad.
export type LayoutNode = { type: 'session'; sessionKey: string } | { type: 'split'; direction: 'horizontal' | 'vertical'; ratio: number; first: LayoutNode; second: LayoutNode };

export type Path = Array<'first' | 'second'>;

export function paneLeaves(node: LayoutNode, path: Path = []): Array<{ sessionKey: string; path: Path }> {
  return node.type === 'session' ? [{ sessionKey: node.sessionKey, path }] : [
    ...paneLeaves(node.first, [...path, 'first']),
    ...paneLeaves(node.second, [...path, 'second']),
  ];
}

export function nodeAt(node: LayoutNode, path: Path): LayoutNode | null {
  for (const part of path) {
    if (node.type !== 'split') return null;
    node = node[part];
  }
  return node;
}

function matches(n: LayoutNode, path: Path, target: string | Path): boolean {
  return n.type === 'session' && (typeof target === 'string'
    ? n.sessionKey === target
    : path.length === target.length && path.every((part, i) => part === target[i]));
}

export function leaves(node: LayoutNode): string[] {
  return node.type === 'session' ? [node.sessionKey] : [...leaves(node.first), ...leaves(node.second)];
}

function mapNode(node: LayoutNode, fn: (n: LayoutNode, path: Path) => LayoutNode | null, path: Path = []): LayoutNode | null {
  const next = fn(node, path);
  if (next === null || next !== node) return next;
  if (node.type === 'split') {
    const first = mapNode(node.first, fn, [...path, 'first']);
    const second = mapNode(node.second, fn, [...path, 'second']);
    if (first === null) return second;
    if (second === null) return first;
    if (first !== node.first || second !== node.second) return { ...node, first, second };
  }
  return node;
}

/**
 * Split the pane showing `target` — its half keeps `target`, the new half shows
 * `next`. `place: 'before'` puts the new pane first (left/top drops).
 */
export function splitLeaf(root: LayoutNode, target: string | Path, direction: 'horizontal' | 'vertical', next: string, place: 'before' | 'after' = 'after'): LayoutNode {
  const out = mapNode(root, (n, path) =>
    matches(n, path, target)
      ? place === 'after'
        ? { type: 'split', direction, ratio: 0.5, first: n, second: { type: 'session', sessionKey: next } }
        : { type: 'split', direction, ratio: 0.5, first: { type: 'session', sessionKey: next }, second: n }
      : n,
  );
  return out ?? root;
}

/** Point the pane showing `target` at `next` instead (center drop, replace action). */
export function replaceLeaf(root: LayoutNode, target: string | Path, next: string): LayoutNode {
  return (mapNode(root, (n, path) => (matches(n, path, target) ? { type: 'session', sessionKey: next } : n)) ?? root);
}

/** Close the pane showing `target`; its sibling takes the freed space. Null when it was the only pane. */
export function closeLeaf(root: LayoutNode, target: string | Path): LayoutNode | null {
  return mapNode(root, (n, path) => (matches(n, path, target) ? null : n));
}

export function setRatio(root: LayoutNode, path: Path, ratio: number): LayoutNode {
  const clamped = Math.min(0.85, Math.max(0.15, ratio));
  // Only the split at the full path gets the new ratio.
  const at = (n: LayoutNode, i: number): LayoutNode => {
    if (n.type === 'session') return n;
    if (i === path.length) return { ...n, ratio: clamped };
    const k = path[i];
    return { ...n, [k]: at(n[k], i + 1) };
  };
  return at(root, 0);
}

export type PaneDir = 'left' | 'right' | 'up' | 'down';

type Box = { x: number; y: number; w: number; h: number };

function layoutBoxes(node: LayoutNode, box: Box, path: Path, out: Array<{ path: Path; box: Box }>): void {
  if (node.type === 'session') {
    out.push({ path, box });
    return;
  }
  const across = node.direction === 'horizontal';
  const span = (across ? box.w : box.h) * node.ratio;
  const first: Box = across ? { x: box.x, y: box.y, w: span, h: box.h } : { x: box.x, y: box.y, w: box.w, h: span };
  const second: Box = across
    ? { x: box.x + span, y: box.y, w: box.w - span, h: box.h }
    : { x: box.x, y: box.y + span, w: box.w, h: box.h - span };
  layoutBoxes(node.first, first, [...path, 'first'], out);
  layoutBoxes(node.second, second, [...path, 'second'], out);
}

function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

/**
 * The pane in `dir` from `from`. A neighbor has to share part of the edge you
 * are leaving, so a corner touch does not count. The nearest edge wins, then
 * the pane that shares more of it. Equal panes keep tree order, so a move
 * right from a full-height pane into a stack lands on the top one.
 */
export function neighborPane(root: LayoutNode, from: Path, dir: PaneDir): Path | null {
  const panes: Array<{ path: Path; box: Box }> = [];
  layoutBoxes(root, { x: 0, y: 0, w: 1, h: 1 }, [], panes);
  const origin = panes.find((p) => samePath(p.path, from));
  if (!origin) return null;
  const o = origin.box;
  const across = dir === 'left' || dir === 'right';
  const ranked = panes.flatMap((p) => {
    if (samePath(p.path, from)) return [];
    const b = p.box;
    const gap = dir === 'right' ? b.x - (o.x + o.w) : dir === 'left' ? o.x - (b.x + b.w) : dir === 'down' ? b.y - (o.y + o.h) : o.y - (b.y + b.h);
    const overlap = across
      ? Math.min(o.y + o.h, b.y + b.h) - Math.max(o.y, b.y)
      : Math.min(o.x + o.w, b.x + b.w) - Math.max(o.x, b.x);
    if (gap < -1e-6 || overlap <= 1e-6) return [];
    const centerDist = across ? Math.abs(o.y + o.h / 2 - (b.y + b.h / 2)) : Math.abs(o.x + o.w / 2 - (b.x + b.w / 2));
    return [{ path: p.path, gap, overlap, centerDist }];
  });
  ranked.sort((a, b) => a.gap - b.gap || b.overlap - a.overlap || a.centerDist - b.centerDist);
  return ranked[0]?.path ?? null;
}

/** Parse a stored layout without trusting it: wrong shapes become null. */
export function parseLayout(v: unknown): LayoutNode | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.type === 'session') return typeof o.sessionKey === 'string' ? { type: 'session', sessionKey: o.sessionKey } : null;
  if (o.type === 'split') {
    const first = parseLayout(o.first);
    const second = parseLayout(o.second);
    const ratio = typeof o.ratio === 'number' && Number.isFinite(o.ratio) ? Math.min(0.85, Math.max(0.15, o.ratio)) : 0.5;
    if (!first || !second) return first ?? second;
    if (o.direction !== 'horizontal' && o.direction !== 'vertical') return null;
    return { type: 'split', direction: o.direction, ratio, first, second };
  }
  return null;
}
