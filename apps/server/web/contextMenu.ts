import { useLayoutEffect, type RefObject } from 'react';
import { menuViewport, placeFloatingMenu } from './menuPlace.ts';

const HOLD_MS = 500;
const SLOP = 10;

// One finger holds one row at a time: the press in progress, shared by every row.
let timer: number | null = null;
let start: { x: number; y: number } | null = null;
let fired = false;
const stop = () => {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  start = null;
};

/**
 * A row's menu the way iPadOS and desktops open one: a secondary click (two fingers on a
 * trackpad, a right click) or a finger held still on it. The held finger's lift doesn't
 * also click the row. A drag that starts instead (a long press also lifts a row to
 * reorder it) is still a drag, and the row closes the menu when it does. Spread on the
 * row; a row with its own onDragStart calls `onDragStart` from it.
 */
export function contextMenu(open: () => void) {
  return {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      stop();
      open();
    },
    onPointerDown: (e: React.PointerEvent) => {
      fired = false;
      if (e.pointerType !== 'touch') return;
      stop();
      start = { x: e.clientX, y: e.clientY };
      timer = window.setTimeout(() => {
        timer = null;
        fired = true;
        open();
      }, HOLD_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) stop();
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onDragStart: stop,
    // The lift after a hold opened the menu: not a click on the row as well.
    onClickCapture: (e: React.MouseEvent) => {
      if (!fired) return;
      fired = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

/**
 * A row's menu is placed against the screen, not inside the list that scrolls its row
 * (which clipped it): under the row when it fits, over it when that fits, else on the
 * roomier side as tall as the room, scrolling inside, as the session menu is
 * (web/menuPlace.ts). A 44px-row menu on an iPad is long.
 */
export function useFitMenu(ref: RefObject<HTMLElement | null>, open: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    const row = el?.parentElement;
    if (!open || !el || !row) return;
    const view = menuViewport({ width: window.innerWidth, height: window.innerHeight }, window.visualViewport);
    const cap = Math.max(0, view.height - 16);
    el.style.maxHeight = `${cap}px`;
    const r = row.getBoundingClientRect();
    // Layout size: the menu grows from its row as it opens, so its box is still moving.
    const at = placeFloatingMenu({ top: r.top, right: r.right, bottom: r.bottom }, { width: el.offsetWidth, height: el.offsetHeight }, view, 2);
    Object.assign(el.style, { position: 'fixed', top: `${at.top}px`, left: `${at.left}px`, right: 'auto', bottom: 'auto', maxHeight: `${at.maxHeight ?? cap}px`, transformOrigin: at.top < r.top ? 'bottom right' : 'top right' });
    return () => {
      for (const k of ['position', 'top', 'left', 'right', 'bottom', 'maxHeight', 'transformOrigin'] as const) el.style[k] = '';
    };
  }, [ref, open]);
}
