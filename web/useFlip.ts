import { useLayoutEffect, useRef } from 'react';
import { calm, DUR, EASE } from './motion.ts';

type Spots = Map<string, { x: number; y: number }>;

/** Where each `[data-flip]` item inside `box` sits, in the box's scrolled coordinates. */
function measure(box: HTMLElement): Spots {
  const b = box.getBoundingClientRect();
  const out: Spots = new Map();
  for (const el of box.querySelectorAll<HTMLElement>('[data-flip]')) {
    const r = el.getBoundingClientRect();
    if (r.height === 0 && r.width === 0) continue;
    out.set(el.dataset.flip!, { x: r.left - b.left + box.scrollLeft, y: r.top - b.top + box.scrollTop });
  }
  return out;
}

/**
 * Lists that move instead of jump: when `order` (the list's keys, in order)
 * changes, every `[data-flip]` item inside `ref` that changed place plays from
 * where it was (FLIP), so a session moving to "Needs you", a new row, or a
 * closed gap reads as motion you can follow. Items are matched by their
 * data-flip key, even when the element changed (a row that became a card
 * slides from the row). New items fade in where they land; removed ones leave
 * and the rest close up.
 *
 * Nothing is measured unless the order changed: the old places are read
 * during that render (the page still shows them, mid-move included, so an
 * interrupted move carries on from where it is), the new ones after it.
 */
export function useFlip<T extends HTMLElement>(order: string) {
  const ref = useRef<T>(null);
  const shown = useRef<string | null>(null);
  const before = useRef<Spots | null>(null);
  if (shown.current !== null && shown.current !== order && ref.current && !before.current && !calm() && !document.hidden) {
    before.current = measure(ref.current);
  }
  useLayoutEffect(() => {
    const box = ref.current;
    const from = before.current;
    before.current = null;
    if (shown.current === order) return;
    shown.current = order;
    if (!box || !from) return;
    for (const el of box.querySelectorAll<HTMLElement>('[data-flip]')) for (const a of el.getAnimations()) if (a.id === 'flip') a.cancel();
    const now = measure(box);
    // A wholly new list (another page, a new filter) is not a move.
    if (![...now.keys()].some((k) => from.has(k))) return;
    for (const el of box.querySelectorAll<HTMLElement>('[data-flip]')) {
      const to = now.get(el.dataset.flip!);
      if (!to) continue;
      const was = from.get(el.dataset.flip!);
      if (!was) {
        el.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { id: 'flip', duration: DUR.move, easing: EASE, delay: 60, fill: 'backwards' });
        continue;
      }
      const dx = was.x - to.x;
      const dy = was.y - to.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { id: 'flip', duration: DUR.tile, easing: EASE });
    }
  }, [order]);
  return ref;
}
