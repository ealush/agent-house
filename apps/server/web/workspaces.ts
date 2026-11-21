// Workspaces 1–9, Hyprland-style: each holds an arrangement (a split layout, or
// one session) on this device. Switching saves the one you leave and brings the
// other back; sending moves the focused session over. Pure, so tests import it.
import { closeLeaf, normalizeSplit, paneLeaves, splitLeaf, type LayoutNode, type Path } from './layout.ts';

export type Slot = { layout: LayoutNode | null; selected: string | null };
export type Spaces = { current: number; slots: Record<string, Slot> };

export const EMPTY: Slot = { layout: null, selected: null };
const KEY = 'ah.workspaces.v1';

export function loadSpaces(): Spaces {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && typeof v.current === 'number' && v.slots && typeof v.slots === 'object') return v;
  } catch {}
  return { current: 1, slots: {} };
}

export function saveSpaces(s: Spaces) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}

export const occupied = (slot: Slot | undefined) => !!slot && (!!slot.selected || !!slot.layout);

/** Leave the current workspace (keeping `now` in it) for `n`; returns what to show. */
export function switchTo(s: Spaces, n: number, now: Slot): { spaces: Spaces; show: Slot } {
  const slots: Record<string, Slot> = { ...s.slots, [s.current]: now };
  return { spaces: { current: n, slots }, show: n === s.current ? now : (slots[n] ?? EMPTY) };
}

/**
 * Send session `key` (at `path` when in a split) from the current workspace to
 * `n`. It leaves here (its pane closes, or the view goes back to the inbox) and
 * joins there: beside what's there as a new tile, or alone.
 */
export function sendTo(s: Spaces, n: number, key: string, now: Slot, path: Path | null): { spaces: Spaces; show: Slot } {
  if (n === s.current) return { spaces: s, show: now };
  const left: Slot = now.layout && path ? { layout: normalizeSplit(closeLeaf(now.layout, path)), selected: null } : EMPTY;
  // A split that closed down to one pane is that session alone.
  if (now.layout && path && !left.layout) {
    const rest = paneLeaves(closeLeaf(now.layout, path) ?? now.layout).filter((p) => p.sessionKey !== key);
    left.selected = rest[0]?.sessionKey ?? null;
  }
  const there = s.slots[n] ?? EMPTY;
  const joined: Slot = there.layout
    ? { layout: splitLeaf(there.layout, paneLeaves(there.layout).at(-1)!.path, 'horizontal', key), selected: null }
    : there.selected && there.selected !== key
      ? { layout: splitLeaf({ type: 'session', sessionKey: there.selected }, there.selected, 'horizontal', key), selected: null }
      : { layout: null, selected: key };
  return { spaces: { current: s.current, slots: { ...s.slots, [s.current]: left, [n]: joined } }, show: left };
}
