import { useLayoutEffect, useRef } from 'react';
import { calm, DUR, EASE } from './motion.ts';

/**
 * Lists that move instead of jump: after each render, every `[data-flip]`
 * item inside `ref` that changed place plays from where it was (FLIP), so a
 * session moving to "Needs you", a new row, or a closed gap reads as motion
 * you can follow. Items are matched by their data-flip key, even when the
 * element changed (a row that became a card slides from the row). New items
 * fade in where they land; removed ones leave and the rest close up.
 */
export function useFlip<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const last = useRef<Map<string, { x: number; y: number }> | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const items = [...box.querySelectorAll<HTMLElement>('[data-flip]')];
    // Measure where things sit now, without any move still in flight.
    for (const el of items) for (const a of el.getAnimations()) if (a.id === 'flip') a.cancel();
    const b = box.getBoundingClientRect();
    const now = new Map<string, { x: number; y: number }>();
    for (const el of items) {
      const r = el.getBoundingClientRect();
      if (r.height === 0 && r.width === 0) continue;
      now.set(el.dataset.flip!, { x: r.left - b.left + box.scrollLeft, y: r.top - b.top + box.scrollTop });
    }
    const before = last.current;
    last.current = now;
    if (!before || calm() || document.hidden) return;
    // A wholly new list (another page, a new filter) is not a move.
    if (![...now.keys()].some((k) => before.has(k))) return;
    for (const el of items) {
      const to = now.get(el.dataset.flip!);
      if (!to) continue;
      const from = before.get(el.dataset.flip!);
      if (!from) {
        el.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { id: 'flip', duration: DUR.move, easing: EASE, delay: 60, fill: 'backwards' });
        continue;
      }
      const dx = from.x - to.x;
      const dy = from.y - to.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { id: 'flip', duration: DUR.tile, easing: EASE });
    }
  });
  return ref;
}
