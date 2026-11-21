import { useLayoutEffect, useRef, type RefObject } from 'react';
import { calm, DUR, EASE, popIn } from './motion.ts';

/**
 * When a tab comes or goes (Snapshots once the agent is up, Queue with a
 * message waiting), the others slide to their new places and the new one grows
 * in, instead of the row snapping to new widths. Translate only: the tabs are
 * bare icons over the strip, so where each sits is all that shows.
 * `shown` names the tabs on screen; each tab carries `data-tab`.
 */
export function useTabFlow(row: RefObject<HTMLElement | null>, shown: string) {
  const was = useRef<Map<string, DOMRect> | null>(null);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const tabs = [...el.querySelectorAll<HTMLElement>(':scope > [data-tab]')];
    const now = new Map(tabs.map((t) => [t.dataset.tab!, t.getBoundingClientRect()]));
    const before = was.current;
    was.current = now;
    if (!before) return;
    if (calm()) return;
    for (const t of tabs) {
      const to = now.get(t.dataset.tab!)!;
      const from = before.get(t.dataset.tab!);
      // What moves is the tab's icon and name, never its box: the thumb (Glide) measures the box.
      const inner = [...t.children] as HTMLElement[];
      if (!from) {
        for (const c of inner) popIn(c);
        continue;
      }
      // Centre to centre: a tab that changed width (the open one shows its name) moves by its middle.
      const dx = from.x + from.width / 2 - (to.x + to.width / 2);
      if (Math.abs(dx) < 0.5) continue;
      for (const c of inner) c.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: DUR.tile, easing: EASE });
    }
  }, [row, shown]);
  // A rotation or a resized window moves every tab without one coming or going: keep the places current.
  useLayoutEffect(() => {
    const el = row.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      was.current = new Map([...el.querySelectorAll<HTMLElement>(':scope > [data-tab]')].map((t) => [t.dataset.tab!, t.getBoundingClientRect()]));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [row]);
}
