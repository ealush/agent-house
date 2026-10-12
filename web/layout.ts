// Binary split-layout model (F45). Each leaf is an independent viewer onto one
// tmux window — never tmux's own split-pane. Ratios (not pixels) are persisted,
// so a layout moves between a 32" monitor and an 11" iPad.
export type LayoutNode = { type: 'session'; sessionKey: string } | { type: 'split'; direction: 'horizontal' | 'vertical'; ratio: number; first: LayoutNode; second: LayoutNode };

export type Path = Array<'first' | 'second'>;

/**
 * A pane waiting for you to choose what goes in it (a fresh split, or Replace
 * pane). Its key carries the session it replaced, restored if you cancel; a
 * split's chooser carries none and closes instead. Never the same session twice:
 * two viewers of one tmux window fight over its size.
 */
export const PICK = 'pick:';
export const pickKey = (previous = '') => `${PICK}${previous}`;
export const isPick = (key: string) => key.startsWith(PICK);
export const pickPrevious = (key: string) => (isPick(key) ? key.slice(PICK.length) || null : null);

export function paneLeaves(node: LayoutNode, path: Path = []): Array<{ sessionKey: string; path: Path }> {
  return node.type === 'session' ? [{ sessionKey: node.sessionKey, path }] : [
    ...paneLeaves(node.first, [...path, 'first']),
    ...paneLeaves(node.second, [...path, 'second']),
  ];
}

/** A split needs two panes. One pane is the ordinary session, so the layout goes away. */
export function normalizeSplit(node: LayoutNode | null): LayoutNode | null {
  if (!node || paneLeaves(node).length < 2) return null;
  return node;
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

/**
 * Hyprland-style keyboard resize: moves the divider nearest the pane at `path`
 * in the arrow's direction (→ moves a side-by-side divider right, ↓ a stacked
 * one down). The nearest split of the right kind above the pane is the one that
 * moves; with none, the layout comes back unchanged.
 */
export function nudgeDivider(root: LayoutNode, path: Path, dir: PaneDir, step = 0.05): LayoutNode {
  const want = dir === 'left' || dir === 'right' ? 'horizontal' : 'vertical';
  const delta = dir === 'right' || dir === 'down' ? step : -step;
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const at = path.slice(0, depth);
    const n = nodeAt(root, at);
    if (n?.type === 'split' && n.direction === want) return setRatio(root, at, n.ratio + delta);
  }
  return root;
}

export type Box = { x: number; y: number; w: number; h: number };

export type Tile = { sessionKey: string; path: Path; box: Box };
export type Seam = { path: Path; row: boolean; ratio: number; box: Box };

/**
 * Where everything sits, as fractions of the workspace: each pane's box and
 * each split's box (its divider goes at `ratio` across it). Rendering panes
 * flat from this, instead of nesting them, keeps a session mounted while the
 * tree around it changes, so splitting never reconnects its terminal.
 */
export function tileBoxes(root: LayoutNode): { tiles: Tile[]; seams: Seam[] } {
  const tiles: Tile[] = [];
  const seams: Seam[] = [];
  const walk = (node: LayoutNode, box: Box, path: Path) => {
    if (node.type === 'session') return void tiles.push({ sessionKey: node.sessionKey, path, box });
    const row = node.direction === 'horizontal';
    seams.push({ path, row, ratio: node.ratio, box });
    const span = (row ? box.w : box.h) * node.ratio;
    walk(node.first, row ? { ...box, w: span } : { ...box, h: span }, [...path, 'first']);
    walk(node.second, row ? { ...box, x: box.x + span, w: box.w - span } : { ...box, y: box.y + span, h: box.h - span }, [...path, 'second']);
  };
  walk(root, { x: 0, y: 0, w: 1, h: 1 }, []);
  return { tiles, seams };
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
  const panes = tileBoxes(root).tiles;
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

type Side = 'first' | 'second';
type Axis = 'horizontal' | 'vertical';

function dirSide(dir: PaneDir): { axis: Axis; side: Side } {
  if (dir === 'left') return { axis: 'horizontal', side: 'first' };
  if (dir === 'right') return { axis: 'horizontal', side: 'second' };
  if (dir === 'up') return { axis: 'vertical', side: 'first' };
  return { axis: 'vertical', side: 'second' };
}

function setAt(root: LayoutNode, path: Path, next: LayoutNode): LayoutNode {
  if (path.length === 0) return next;
  if (root.type !== 'split') return root;
  const key = path[0];
  return { ...root, [key]: setAt(root[key], path.slice(1), next) };
}

function splitBeside(node: LayoutNode, leaf: LayoutNode, side: Side, axis: Axis): LayoutNode {
  return side === 'first'
    ? { type: 'split', direction: axis, ratio: 0.5, first: leaf, second: node }
    : { type: 'split', direction: axis, ratio: 0.5, first: node, second: leaf };
}

function sameTree(a: LayoutNode, b: LayoutNode): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Put `leaf` on `side` of the container at `slot`, after `leaf` was pulled out
 * of the tree. A perpendicular parent is wrapped, so a pane leaving the bottom
 * of a column spans that whole parent. A parallel parent that still has room
 * in `side` gives the leaf half of the neighbor there.
 */
function placeBeyond(layout: LayoutNode, slot: Path, leaf: LayoutNode, side: Side, axis: Axis): { layout: LayoutNode; path: Path } {
  if (slot.length === 0) return { layout: splitBeside(layout, leaf, side, axis), path: [side] };
  const parentPath = slot.slice(0, -1);
  const parent = nodeAt(layout, parentPath);
  if (!parent || parent.type !== 'split') return { layout, path: slot };
  const slotSide = slot[slot.length - 1];
  if (parent.direction === axis && slotSide === side) return placeBeyond(layout, parentPath, leaf, side, axis);
  if (parent.direction === axis) {
    const next: LayoutNode = { ...parent, [side]: splitBeside(parent[side], leaf, side, axis) };
    return { layout: setAt(layout, parentPath, next), path: [...parentPath, side, side] };
  }
  return { layout: setAt(layout, parentPath, splitBeside(parent, leaf, side, axis)), path: [...parentPath, side] };
}

/**
 * Move the pane one step in `dir`. Toward its sibling, the halves trade places.
 * Already at that edge, the pane is pulled out and spans the parent beyond it:
 * the bottom-right pane moved down becomes a full-width row underneath.
 * A pane that already spans that outer edge stays put, ratio included.
 */
export function moveLeaf(root: LayoutNode, path: Path, dir: PaneDir): { layout: LayoutNode; path: Path } {
  const leaf = nodeAt(root, path);
  if (!leaf || leaf.type !== 'session' || path.length === 0) return { layout: root, path };
  const { axis, side } = dirSide(dir);
  const parentPath = path.slice(0, -1);
  const parent = nodeAt(root, parentPath);
  if (!parent || parent.type !== 'split') return { layout: root, path };
  const at = path[path.length - 1];
  if (parent.direction === axis && at !== side) {
    const swapped: LayoutNode = { ...parent, first: parent.second, second: parent.first };
    return { layout: setAt(root, parentPath, swapped), path: [...parentPath, side] };
  }
  if (parent.direction === axis && at === side && parentPath.length === 0) return { layout: root, path };
  const removed = closeLeaf(root, path);
  if (!removed) return { layout: root, path };
  const placed = placeBeyond(removed, parentPath, leaf, side, axis);
  if (sameTree(placed.layout, root)) return { layout: root, path };
  return placed;
}

/** Flip the split that holds this pane, from side by side to stacked or back. */
export function toggleSplit(root: LayoutNode, path: Path): LayoutNode {
  const parentPath = path.slice(0, -1);
  const parent = nodeAt(root, parentPath);
  if (!parent || parent.type !== 'split') return root;
  const direction: Axis = parent.direction === 'horizontal' ? 'vertical' : 'horizontal';
  return setAt(root, parentPath, { ...parent, direction });
}

/**
 * Pull the pane out and dock it on an outer edge, spanning the workspace.
 * Dropping the bottom-right pane on the bottom edge puts it full width below.
 */
export function dockLeaf(root: LayoutNode, path: Path, dir: PaneDir): { layout: LayoutNode; path: Path } {
  const leaf = nodeAt(root, path);
  if (!leaf || leaf.type !== 'session' || path.length === 0) return { layout: root, path };
  const { axis, side } = dirSide(dir);
  const parent = nodeAt(root, path.slice(0, -1));
  if (path.length === 1 && parent?.type === 'split' && parent.direction === axis && path[0] === side) return { layout: root, path };
  const removed = closeLeaf(root, path);
  if (!removed) return { layout: root, path };
  return { layout: splitBeside(removed, leaf, side, axis), path: [side] };
}

/** Where a path points after the leaf at `from` is removed and its sibling takes the parent slot. */
function pathAfterClose(from: Path, to: Path): Path | null {
  if (from.length === 0) return null;
  if (to.length >= from.length && from.every((part, i) => to[i] === part)) return null;
  const parent = from.slice(0, -1);
  const other: Side = from[from.length - 1] === 'first' ? 'second' : 'first';
  const sibling = [...parent, other];
  if (to.length >= sibling.length && sibling.every((part, i) => to[i] === part)) return [...parent, ...to.slice(sibling.length)];
  return to;
}

export type DropWhere = 'left' | 'right' | 'top' | 'bottom' | 'center';

/** Move the pane at `from` onto the pane at `to`. Center swaps the two sessions. */
export function moveLeafTo(root: LayoutNode, from: Path, to: Path, where: DropWhere): { layout: LayoutNode; path: Path } {
  if (samePath(from, to)) return { layout: root, path: from };
  const leaf = nodeAt(root, from);
  const target = nodeAt(root, to);
  if (!leaf || leaf.type !== 'session' || !target || target.type !== 'session') return { layout: root, path: from };
  if (where === 'center') {
    const layout = replaceLeaf(replaceLeaf(root, from, target.sessionKey), to, leaf.sessionKey);
    return { layout, path: to };
  }
  const dest = pathAfterClose(from, to);
  if (!dest) return { layout: root, path: from };
  const removed = closeLeaf(root, from);
  if (!removed) return { layout: root, path: from };
  const staying = nodeAt(removed, dest);
  if (!staying) return { layout: root, path: from };
  const { axis, side } = dirSide(where === 'left' ? 'left' : where === 'right' ? 'right' : where === 'top' ? 'up' : 'down');
  return { layout: setAt(removed, dest, splitBeside(staying, leaf, side, axis)), path: [...dest, side] };
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

/** The same layout with every pane's session key passed through `fn`. */
export function mapKeys(node: LayoutNode, fn: (key: string) => string): LayoutNode {
  return node.type === 'session' ? { ...node, sessionKey: fn(node.sessionKey) } : { ...node, first: mapKeys(node.first, fn), second: mapKeys(node.second, fn) };
}
