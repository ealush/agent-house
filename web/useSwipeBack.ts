import { useEffect, useRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { calm } from './motion.ts';

/** The view a swipe uncovers: shown (`show(true)`) when a drag starts, moved by the finger. */
export type Underlay = { ref: RefObject<HTMLElement | null>; show: (on: boolean) => void };

// The pop transition's parallax and dimming (styles.css vt-under-in), so a
// swipe and a tap on Back end the same way.
const SHIFT = -28;
const DIM = 0.7;
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

/**
 * Back by swiping from the left edge, the way an iPhone leaves a pushed view:
 * the view follows the finger, and the one it came from is underneath,
 * dimmed and a little to the left, coming forward as the top one leaves.
 * Past a third of the screen (or a flick) it slides away and the view under
 * it is the page; short of that it settles back.
 *
 * Starts only within the edge strip and only on a mostly sideways drag, so a
 * scroll is still a scroll. That holds over a terminal too, which fills a
 * shell session edge to edge: it keeps every touch (one finger scrolls tmux)
 * until a drag from the edge turns out to be a swipe, and none after. Text
 * fields keep their selection.
 */
export function useSwipeBack(view: RefObject<HTMLElement | null>, enabled: boolean, back: () => void, under: Underlay) {
  // The latest callbacks, without re-binding (and dropping) a drag on every render.
  const go = useRef(back);
  go.current = back;
  const peek = useRef(under);
  peek.current = under;
  useEffect(() => {
    const el = view.current;
    if (!enabled || !el) return;
    const EDGE = 28;
    let start: { x: number; y: number; t: number } | null = null;
    let engaged = false;
    let settling = false;
    let dx = 0;
    let width = 1;

    const below = () => peek.current.ref.current;
    const place = (p: number) => {
      el.style.transform = `translate3d(${p * width}px, 0, 0)`;
      const u = below();
      if (!u) return;
      u.style.transform = `translate3d(${SHIFT * (1 - p)}%, 0, 0)`;
      u.style.filter = `brightness(${DIM + (1 - DIM) * p})`;
    };
    const reset = () => {
      el.style.transform = '';
      el.style.boxShadow = '';
      el.style.transition = '';
      el.style.willChange = '';
    };

    const onStart = (e: TouchEvent) => {
      if (settling || e.touches.length !== 1) return;
      const t = e.touches[0];
      const target = e.target as Element | null;
      if (t.clientX > EDGE || target?.closest('input, textarea, [contenteditable]')) return;
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
        width = el.getBoundingClientRect().width || 1;
        // The page underneath renders now, before the first frame of the drag.
        flushSync(() => peek.current.show(true));
        el.style.willChange = 'transform';
        el.style.boxShadow = '-12px 0 32px rgb(0 0 0 / 0.35)';
      }
      e.preventDefault();
      e.stopPropagation();
      dx = Math.max(0, x);
      place(dx / width);
    };

    const onEnd = () => {
      if (!start) return;
      const was = start;
      start = null;
      if (!engaged) return;
      engaged = false;
      const speed = dx / Math.max(1, performance.now() - was.t);
      const leave = dx > width / 3 || (speed > 0.5 && dx > 40);
      const quick = calm();
      const u = below();
      // The rest of the way at the speed the finger left, near enough: a long way left goes slower.
      const ms = Math.round((leave ? 160 : 140) + 160 * (leave ? 1 - dx / width : dx / width));
      const how = quick ? '' : `${ms}ms ${EASE}`;
      el.style.transition = how && `transform ${how}`;
      if (u) u.style.transition = how && `transform ${how}, filter ${how}`;
      place(leave ? 1 : 0);
      const done = () => {
        settling = false;
        if (leave) flushSync(() => go.current());
        flushSync(() => peek.current.show(false));
        reset();
      };
      if (quick) return done();
      settling = true;
      // transitionend never comes when nothing moved; the timer is the backstop.
      let finished = false;
      const once = (e?: Event) => {
        // A control inside finishing its own transition says nothing about this one.
        if (finished || (e && e.target !== el)) return;
        finished = true;
        el.removeEventListener('transitionend', once);
        done();
      };
      el.addEventListener('transitionend', once);
      setTimeout(once, ms + 80);
    };

    // Capture: ahead of the terminal's own listeners, so a swipe can keep its moves from it.
    el.addEventListener('touchstart', onStart, { capture: true, passive: true });
    el.addEventListener('touchmove', onMove, { capture: true, passive: false });
    el.addEventListener('touchend', onEnd, true);
    el.addEventListener('touchcancel', onEnd, true);
    return () => {
      el.removeEventListener('touchstart', onStart, true);
      el.removeEventListener('touchmove', onMove, true);
      el.removeEventListener('touchend', onEnd, true);
      el.removeEventListener('touchcancel', onEnd, true);
      reset();
      peek.current.show(false);
    };
  }, [view, enabled]);
}
