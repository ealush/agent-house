import type { Win } from './api.ts';

const STATUS_RANK = { waiting: 0, busy: 1, attention: 2, idle: 3 };

/** Sort: pinned first, then manual order, then status/activity for never-arranged rows. */
export function sortWindows(windows: Win[]): Win[] {
  return [...windows].sort((a, b) => {
    if (Number(b.pinned) !== Number(a.pinned)) return Number(b.pinned) - Number(a.pinned);
    if (a.order != null && b.order != null) return a.order - b.order;
    if (a.order != null) return -1;
    if (b.order != null) return 1;
    return STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.activity - a.activity;
  });
}

export type SideSection = { id: string; run: boolean; windows: Win[] };

/**
 * Sidebar paint order. Recipe runs come first, then one block per project
 * (or per host when more than one machine is online). Within a block, rows
 * keep sortWindows order. The flat sort interleaves blocks, so callers that
 * walk sessions top to bottom use this instead.
 */
export function sidebarSections(windows: Win[], multiHost: boolean): SideSection[] {
  const runs = new Map<string, Win[]>();
  const groups = new Map<string, Win[]>();
  for (const w of sortWindows(windows)) {
    if (w.run) {
      const list = runs.get(w.run.runId);
      if (list) list.push(w);
      else runs.set(w.run.runId, [w]);
      continue;
    }
    const id = multiHost ? w.host : w.project;
    const list = groups.get(id);
    if (list) list.push(w);
    else groups.set(id, [w]);
  }
  return [
    ...[...runs].map(([id, ws]) => ({ id, run: true, windows: ws })),
    ...[...groups].map(([id, ws]) => ({ id, run: false, windows: ws })),
  ];
}

/** Sessions in the order the sidebar draws them, top to bottom. */
export function sidebarOrder(windows: Win[], multiHost: boolean): Win[] {
  return sidebarSections(windows, multiHost).flatMap((section) => section.windows);
}
