// Session keys used to be tmux window ids ("@12", "mac/@12"). They are uids
// now, which outlive the window. Links and layouts saved under the old keys are
// upgraded once the windows are known. Pure, so tests import it.
import { isPick, leaves, mapKeys, pickKey, type LayoutNode } from './layout.ts';
import type { Slot, Spaces } from './workspaces.ts';

type Keyed = { id: string; key: string };

/** A session's link, as the app's Copy Link makes it (`AppLink.webURL`): this page with the session's key for its place. */
export function sessionLink(key: string, origin: string): string {
  return `${origin}/#${key}`;
}

export const isLegacyKey = (key: string) => /(^|\/)@\d+$/.test(key);

/** The current key for `key`: itself unless it is a window id, then the window's uid key (or null if it's gone). */
export function upgradeKey(key: string, windows: Keyed[]): string | null {
  if (!isLegacyKey(key)) return key;
  const cut = key.lastIndexOf('/');
  const host = cut < 0 ? null : key.slice(0, cut);
  const id = key.slice(cut + 1);
  const w = windows.find((w) => w.id === id && (host ? w.key.startsWith(`${host}/`) : !w.key.includes('/')));
  return w?.key ?? null;
}

/** A pane whose window is gone asks what goes in it instead. */
export function upgradeLayout(layout: LayoutNode | null, windows: Keyed[]): LayoutNode | null {
  return layout && mapKeys(layout, (k) => (isPick(k) ? k : (upgradeKey(k, windows) ?? pickKey())));
}

export function upgradeSpaces(spaces: Spaces, windows: Keyed[]): Spaces {
  const slots: Record<string, Slot> = {};
  for (const [n, slot] of Object.entries(spaces.slots)) {
    slots[n] = { layout: upgradeLayout(slot.layout, windows), selected: slot.selected && upgradeKey(slot.selected, windows) };
  }
  return { ...spaces, slots };
}

export function hasLegacy(layout: LayoutNode | null, spaces: Spaces, ...keys: Array<string | null>): boolean {
  const all = [...keys, ...(layout ? leaves(layout) : []), ...Object.values(spaces.slots).flatMap((s) => [s.selected, ...(s.layout ? leaves(s.layout) : [])])];
  return all.some((k) => !!k && isLegacyKey(k));
}

