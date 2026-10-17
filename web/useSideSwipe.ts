import { useEffect, useRef, type RefObject } from 'react';
import { EDGE } from './edges.ts';

/**
 * The sidebar that slides over the page (an iPad in portrait, a narrow window), by
 * finger, the way iPadOS apps' sidebars come and go: a drag in from the left edge
 * brings it out, a drag to the left on it puts it away, and Escape too.
 *
 * Only a mostly sideways drag counts, so scrolling the page or the sidebar's list
 * stays a scroll. Text fields keep their selection. Capture, so the terminal (which
 * keeps every touch for tmux) doesn't take the drag first.
 */
export function useSideSwipe(enabled: boolean, open: boolean, setOpen: (v: boolean) => void, sheet: RefObject<HTMLElement | null>) {
  const set = useRef(setOpen);
  set.current = setOpen;
  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number } | null = null;
    let done = false;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return void (start = null);
      const t = e.touches[0];
      const target = e.target as Element | null;
      if (target?.closest('input, textarea, select, [contenteditable]')) return void (start = null);
      // Closed: only from the left edge. Open: anywhere on the sidebar or the dimmed page.
      if (!open && t.clientX > EDGE) return void (start = null);
      if (open && sheet.current && !sheet.current.contains(target) && !target?.closest('.side-scrim')) return void (start = null);
      start = { x: t.clientX, y: t.clientY };
      done = false;
    };
    const onMove = (e: TouchEvent) => {
      if (!start || done) return;
      const t = e.touches[0];
      const x = t.clientX - start.x;
      const y = t.clientY - start.y;
      if (Math.abs(y) > 14 && Math.abs(y) > Math.abs(x)) return void (start = null);
      const far = open ? -x : x;
      if (far < 28 || far < Math.abs(y) * 1.3) return;
      done = true;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      set.current(!open);
    };
    const onEnd = () => {
      start = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (open && e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        set.current(false);
      }
    };
    window.addEventListener('touchstart', onStart, { capture: true, passive: true });
    window.addEventListener('touchmove', onMove, { capture: true, passive: false });
    window.addEventListener('touchend', onEnd, true);
    window.addEventListener('touchcancel', onEnd, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('touchstart', onStart, true);
      window.removeEventListener('touchmove', onMove, true);
      window.removeEventListener('touchend', onEnd, true);
      window.removeEventListener('touchcancel', onEnd, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [enabled, open, sheet]);
}
