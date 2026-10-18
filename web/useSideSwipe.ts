import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { EDGE } from './edges.ts';

/** How far (of its width) or how fast (px/ms) a released drag must have gone to finish. */
const PAST = 0.4;
const FLICK = 0.35;

/**
 * Where the sidebar settles when the finger lets go: open if the drag left it more
 * than PAST out, unless the finger was flicking the other way; a flick decides alone.
 * `shown` is how much of it shows (0–1), `speed` the finger's px/ms (+ is rightwards).
 */
export function settle(shown: number, speed: number): boolean {
  if (speed > FLICK) return true;
  if (speed < -FLICK) return false;
  return shown > PAST;
}

/**
 * The sidebar that slides over the page (an iPad in portrait, a narrow window), by
 * finger, the way iPadOS apps' sidebars come and go: it follows the finger, in from the
 * left edge or back out from on it or the dimmed page, and the release settles it open
 * or shut by how far and how fast it went (settle). Escape puts it away too.
 *
 * Only a mostly sideways drag counts, so scrolling the page or the sidebar's list
 * stays a scroll. Text fields keep their selection. Capture, so the terminal (which
 * keeps every touch for tmux) doesn't take the drag first.
 *
 * Returns whether a drag is showing a closed sidebar: render the sheet while it is.
 * The sheet and scrim are moved by style while the finger is down, never re-rendered.
 */
export function useSideSwipe(
  enabled: boolean,
  open: boolean,
  setOpen: (v: boolean) => void,
  sheet: RefObject<HTMLElement | null>,
  scrim: RefObject<HTMLElement | null>,
): boolean {
  const set = useRef(setOpen);
  set.current = setOpen;
  // Read by the touch handlers, and set by a release before React has re-rendered:
  // a finger can take the sidebar again while it is still settling.
  const isOpen = useRef(open);
  isOpen.current = open;
  const [peek, setPeek] = useState(false);
  // The drag's translateX (px, ≤ 0), painted onto the sheet whenever it is mounted.
  const at = useRef<number | null>(null);

  const paint = () => {
    const el = sheet.current;
    if (!el || at.current === null) return;
    const w = el.offsetWidth || 1;
    el.style.animation = 'none';
    el.style.transition = 'none';
    el.style.transform = `translateX(${at.current}px)`;
    if (scrim.current) {
      scrim.current.style.animation = 'none';
      scrim.current.style.transition = 'none';
      scrim.current.style.opacity = String(1 + at.current / w);
    }
  };
  // The sheet mounts a frame after a drag starts showing it.
  useLayoutEffect(paint, [peek]);

  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number } | null = null;
    let following = false;
    let last = { x: 0, t: 0 };
    let speed = 0;
    // The release still settling the sheet: a new touch finishes it first.
    let settling: (() => void) | null = null;

    const onStart = (e: TouchEvent) => {
      start = null;
      following = false;
      settling?.();
      if (e.touches.length !== 1) return;
      const open = isOpen.current;
      const t = e.touches[0];
      const target = e.target as Element | null;
      if (target?.closest('input, textarea, select, [contenteditable]')) return;
      // Closed: only from the left edge. Open: anywhere on the sidebar or the dimmed page.
      if (!open && t.clientX > EDGE) return;
      if (open && sheet.current && !sheet.current.contains(target) && !target?.closest('.side-scrim')) return;
      start = { x: t.clientX, y: t.clientY };
      last = { x: t.clientX, t: e.timeStamp };
      speed = 0;
    };

    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const open = isOpen.current;
      const t = e.touches[0];
      const x = t.clientX - start.x;
      const y = t.clientY - start.y;
      if (!following) {
        if (Math.abs(y) > 14 && Math.abs(y) > Math.abs(x)) return void (start = null);
        const far = open ? -x : x;
        if (far < 10 || far < Math.abs(y) * 1.3) return;
        following = true;
        if (!open) setPeek(true);
      }
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      const dt = e.timeStamp - last.t;
      if (dt > 0) speed = 0.6 * ((t.clientX - last.x) / dt) + 0.4 * speed;
      last = { x: t.clientX, t: e.timeStamp };
      const w = sheet.current?.offsetWidth ?? 280;
      // In: the sidebar's edge under the finger. Out: it moves as far as the finger has.
      at.current = Math.min(0, Math.max(-w, open ? x : t.clientX - w));
      paint();
    };

    const onEnd = (e: TouchEvent) => {
      if (!start || !following) return void (start = null);
      start = null;
      following = false;
      // A finger held still before the lift isn't flicking.
      if (e.timeStamp - last.t > 80) speed = 0;
      const el = sheet.current;
      const w = el?.offsetWidth || 280;
      const to = settle(1 + (at.current ?? 0) / w, speed);
      at.current = null;
      const done = () => {
        if (to !== isOpen.current) set.current(to);
        isOpen.current = to;
        setPeek(false);
        // Open now by state (or gone): let the sheet's own styles back.
        if (el) for (const k of ['transform', 'transition'] as const) el.style[k] = '';
        if (scrim.current) for (const k of ['opacity', 'transition'] as const) scrim.current.style[k] = '';
      };
      if (!el) return done();
      const ease = 'var(--dur-2) var(--ease)';
      el.style.transition = `transform ${ease}`;
      el.style.transform = to ? 'translateX(0)' : `translateX(${-w}px)`;
      if (scrim.current) {
        scrim.current.style.transition = `opacity ${ease}`;
        scrim.current.style.opacity = to ? '1' : '0';
      }
      // transitionend, or soon anyway (reduced motion, a sheet that never moved).
      let fired = false;
      const once = (e?: Event) => {
        // Only the sheet's own slide, not a row's hover fading inside it.
        if (fired || (e && e.target !== el)) return;
        fired = true;
        settling = null;
        el.removeEventListener('transitionend', once);
        done();
      };
      settling = once;
      el.addEventListener('transitionend', once);
      window.setTimeout(once, 320);
    };

    const onKey = (e: KeyboardEvent) => {
      if (isOpen.current && e.key === 'Escape' && !e.defaultPrevented) {
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
  }, [enabled, sheet, scrim]);

  return enabled && peek;
}
