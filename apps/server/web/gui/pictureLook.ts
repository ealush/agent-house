// How a message's pictures sit in the conversation, on this device (Settings → Appearance):
// in a pile that says there are more under the top one, or side by side as tiles.
import { useSyncExternalStore } from 'react';

export type PictureLook = 'stack' | 'grid';

const KEY = 'ah.pictures';
const listeners = new Set<() => void>();

function read(): PictureLook {
  try {
    return localStorage.getItem(KEY) === 'grid' ? 'grid' : 'stack';
  } catch {
    return 'stack';
  }
}

let look = read();

export function setPictureLook(next: PictureLook) {
  look = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {}
  for (const l of listeners) l();
}

export function usePictureLook(): PictureLook {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => look,
  );
}
