import type { Win } from './api.ts';

/** Sparse key between two neighbors: midpoint, or ±100 at the ends. */
export function orderBetween(before: number | null, after: number | null): number {
  if (before == null && after == null) return 100;
  if (before == null) return after! - 100;
  if (after == null) return before + 100;
  if (after - before < 0.001) return before + 0.5;
  return (before + after) / 2;
}

function created(w: Win): number {
  return typeof w.createdAt === 'number' && w.createdAt > 0 ? w.createdAt : Number.POSITIVE_INFINITY;
}

/**
 * Row order inside one pin band. Drag keys win. A session that has never been
 * given a key slots in by the time it was opened, so it stays with the
 * conversations that started around then instead of jumping to the end.
 */
function arrange(windows: Win[]): Win[] {
  const byKey = (a: Win, b: Win) => a.key.localeCompare(b.key);
  const ordered = windows.filter((w) => w.order != null).sort((a, b) => a.order! - b.order! || created(a) - created(b) || byKey(a, b));
  const fresh = windows.filter((w) => w.order == null).sort((a, b) => created(a) - created(b) || byKey(a, b));
  const out = [...ordered];
  for (const w of fresh) {
    const at = created(w);
    const i = out.findIndex((row) => created(row) > at);
    out.splice(i < 0 ? out.length : i, 0, w);
  }
  return out;
}

/**
 * Row order inside one block. A pin stays at the top of its block. Everything
 * else follows a manual drag key, with never-arranged rows in opening order.
 * Status and activity never move a row.
 */
export function sortWindows(windows: Win[]): Win[] {
  return [...arrange(windows.filter((w) => w.pinned)), ...arrange(windows.filter((w) => !w.pinned))];
}

export type SideSection = { id: string; run: boolean; windows: Win[] };

function openedAt(ws: Win[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const w of ws) {
    const at = created(w);
    if (at < min) min = at;
  }
  return min;
}

function byOpened(a: [string, Win[]], b: [string, Win[]]): number {
  const ao = openedAt(a[1]);
  const bo = openedAt(b[1]);
  if (ao !== bo) return ao < bo ? -1 : 1;
  return a[0].localeCompare(b[0]);
}

/**
 * Opening order, unless the user has dragged the blocks. Ids in `saved` keep
 * that sequence. A block that has never been saved (just opened) goes at the end.
 */
export function applyGroupOrder(openingIds: string[], saved: string[]): string[] {
  if (saved.length === 0) return openingIds;
  const rank = new Map<string, number>();
  saved.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  const known = openingIds.filter((id) => rank.has(id)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  const fresh = openingIds.filter((id) => !rank.has(id));
  return [...known, ...fresh];
}

/**
 * Saved id list after a drag. Blocks that are closed keep their place relative
 * to the ones still on screen.
 */
export function saveGroupMove(visible: string[], saved: string[], fromId: string, toId: string, after: boolean): string[] {
  if (fromId === toId) return saved;
  const current = applyGroupOrder(visible, saved);
  if (!current.includes(fromId) || !current.includes(toId)) return saved;
  const next = current.filter((id) => id !== fromId);
  let idx = next.indexOf(toId);
  if (after) idx += 1;
  next.splice(idx, 0, fromId);
  return weave(saved, next);
}

function weave(saved: string[], visibleNext: string[]): string[] {
  if (saved.length === 0) return [...visibleNext];
  const visible = new Set(visibleNext);
  const result = [...saved];
  const slots: number[] = [];
  for (let i = 0; i < result.length; i++) if (visible.has(result[i])) slots.push(i);
  const known = new Set(saved);
  for (const id of visibleNext) {
    if (!known.has(id)) {
      result.push(id);
      slots.push(result.length - 1);
    }
  }
  visibleNext.forEach((id, i) => {
    result[slots[i]] = id;
  });
  return result;
}

/**
 * Sidebar paint order. Recipe runs come first, oldest run first. Then one
 * block per project, or per host when more than one machine is online.
 * A block stays in the order its first session was opened, unless `savedGroups`
 * records a drag. Drag keys apply only inside the block.
 */
export function sidebarSections(windows: Win[], multiHost: boolean, savedGroups: string[] = []): SideSection[] {
  const runs = new Map<string, Win[]>();
  const groups = new Map<string, Win[]>();
  for (const w of windows) {
    const bucket = w.run ? runs : groups;
    const id = w.run ? w.run.runId : multiHost ? w.host : w.project;
    const list = bucket.get(id);
    if (list) list.push(w);
    else bucket.set(id, [w]);
  }
  const finish = (id: string, run: boolean, ws: Win[]): SideSection => ({ id, run, windows: sortWindows(ws) });
  const runList = [...runs].sort(byOpened).map(([id, ws]) => finish(id, true, ws));
  const opened = [...groups].sort(byOpened);
  const byId = new Map(opened);
  const groupList = applyGroupOrder(
    opened.map(([id]) => id),
    savedGroups,
  ).map((id) => finish(id, false, byId.get(id)!));
  return [...runList, ...groupList];
}

/** Sessions in the order the sidebar draws them, top to bottom. */
export function sidebarOrder(windows: Win[], multiHost: boolean, savedGroups: string[] = []): Win[] {
  return sidebarSections(windows, multiHost, savedGroups).flatMap((section) => section.windows);
}

/**
 * Order keys to persist so `draggedKey` lands just before or just after
 * `targetKey` in `list` (the block's current visual order). One key is enough
 * when every row already has one. A block that still has unarranged rows gets
 * a key on each row, so a later status change cannot pull them apart.
 */
export function movedSessionOrders(list: Win[], draggedKey: string, targetKey: string, after: boolean): Array<{ key: string; order: number }> {
  if (draggedKey === targetKey) return [];
  const dragged = list.find((w) => w.key === draggedKey);
  if (!dragged || !list.some((w) => w.key === targetKey)) return [];
  const rest = list.filter((w) => w.key !== draggedKey);
  let idx = rest.findIndex((w) => w.key === targetKey);
  if (after) idx += 1;
  const placed = [...rest];
  placed.splice(idx, 0, dragged);
  if (list.every((w) => w.order != null)) {
    const before = idx > 0 ? rest[idx - 1].order : null;
    const next = idx < rest.length ? rest[idx].order : null;
    const order = orderBetween(before, next);
    return order === dragged.order ? [] : [{ key: draggedKey, order }];
  }
  return placed.map((w, i) => ({ key: w.key, order: (i + 1) * 100 })).filter((row, i) => placed[i].order !== row.order);
}
