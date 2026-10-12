import { flushSync } from 'react-dom';

/**
 * Run a navigation as a quick cross-fade of the main area (View Transitions,
 * where the browser has them). Skipped for reduced motion, a hidden tab, or
 * another transition still running, so rapid switching never queues fades.
 */
let running = false;
export function transition(fn: () => void) {
  const d = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
  if (!d.startViewTransition || running || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return fn();
  running = true;
  try {
    d.startViewTransition(() => flushSync(fn)).finished.finally(() => (running = false));
  } catch {
    running = false;
    fn();
  }
}

/** The CSS motion tokens (styles.css --ease, --dur-1, --dur-2), for animations started from script. */
export const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
export const DUR = { quick: 120, move: 200, tile: 240 } as const;
export const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

type Rect = { x: number; y: number; w: number; h: number };

/**
 * Show where something came from: it is already in its new place, and this
 * plays it from the old one (FLIP). Translate and scale only, so it stays
 * on the compositor, and the content inside is live the whole time.
 */
export function glide(el: HTMLElement, from: Rect, to: Rect, duration: number = DUR.tile) {
  if (calm() || to.w <= 0 || to.h <= 0) return;
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  const sx = from.w / to.w;
  const sy = from.h / to.h;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) return;
  el.animate([{ transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transformOrigin: '0 0', transform: 'none' }], {
    duration,
    easing: EASE,
  });
}

/** Something new arrives where it will stay: a small grow and fade, like a window opening on a tiling desktop. */
export function popIn(el: HTMLElement, duration: number = DUR.tile) {
  if (calm()) return;
  el.animate([{ opacity: 0, transform: 'scale(0.94)' }, { opacity: 1, transform: 'none' }], { duration, easing: EASE });
}
