import { useEffect, useRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { calm } from './motion.ts';

/**
 * Back by swiping from the left edge, the way an iPhone leaves a pushed view:
 * the view follows the finger, and past a third of the screen (or a flick) it
 * slides away and the list is there; short of that it settles back.
 *
 * Starts only within the edge strip and only on a mostly sideways drag, so a
 * scroll is still a scroll. The terminal keeps its own touch handling (one
 * finger scrolls tmux), and text fields keep their selection.
 */
export function useSwipeBack(view: RefObject<HTMLElement | null>, enabled: boolean, back: () => void) {
  // The latest callback, without re-binding (and dropping) a drag on every render.
  const go = useRef(back);
  go.current = back;
  useEffect(() => {
    const el = view.current;
    if (!enabled || !el) return;
    const EDGE = 24;
    let start: { x: number; y: number; t: number } | null = null;
    let engaged = false;
    let dx = 0;

    const reset = () => {
      el.style.transform = '';
      el.style.boxShadow = '';
      el.style.transition = '';
      el.style.willChange = '';
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const target = e.target as Element | null;
      if (t.clientX > EDGE || target?.closest('.term, input, textarea, [contenteditable]')) return;
      start = { x: t.clientX, y: t.clientY, t: performance.now() };
      engaged = false;
      dx = 0;
    };

    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      const x = t.clientX - start.x;
      const y = t.clientY - start.y;
      if (!engaged) {
        if (Math.abs(y) > 12 && Math.abs(y) > Math.abs(x)) {
          start = null;
          return;
        }
        if (x < 10 || x < Math.abs(y) * 1.3) return;
        engaged = true;
        el.style.willChange = 'transform';
        el.style.boxShadow = '-16px 0 40px rgb(0 0 0 / 0.35)';
      }
      e.preventDefault();
      dx = Math.max(0, x);
      el.style.transform = `translateX(${dx}px)`;
    };

    const onEnd = () => {
      if (!start) return;
      const was = start;
      start = null;
      if (!engaged) return;
      engaged = false;
      const width = el.getBoundingClientRect().width;
      const speed = dx / Math.max(1, performance.now() - was.t);
      const leave = dx > width / 3 || (speed > 0.5 && dx > 40);
      const quick = calm();
      el.style.transition = quick ? '' : `transform ${leave ? 220 : 260}ms cubic-bezier(0.32, 0.72, 0, 1)`;
      el.style.transform = leave ? `translateX(${width}px)` : 'translateX(0)';
      const done = () => {
        if (!leave) return reset();
        flushSync(() => go.current());
        reset();
        // The list was underneath: it comes forward from a little to the left.
        if (!quick) el.animate([{ transform: 'translateX(-20%)', opacity: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
      };
      if (quick) return done();
      // transitionend never comes when nothing moved; the timer is the backstop.
      let finished = false;
      const once = () => {
        if (finished) return;
        finished = true;
        done();
      };
      el.addEventListener('transitionend', once, { once: true });
      setTimeout(once, 320);
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      reset();
    };
  }, [view, enabled]);
}
