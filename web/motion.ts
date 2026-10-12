import { flushSync } from 'react-dom';

/**
 * Which way a navigation goes, so the new view arrives from there: down or up
 * the sidebar's list on a desktop, and on a phone a push into a session and a
 * pop back out of it, like an iOS navigation stack (styles.css `data-vt`).
 */
export type Heading = 'down' | 'up' | 'push' | 'pop';

/**
 * Run a navigation as a quick move of the main area (View Transitions, where
 * the browser has them): a cross-fade, or a slide when `heading` says which
 * way. Skipped for reduced motion, a hidden tab, or another transition still
 * running, so rapid switching never queues animations.
 */
let running = false;
export function transition(fn: () => void, heading?: Heading | null) {
  const d = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
  if (!d.startViewTransition || running || document.hidden || calm()) return fn();
  running = true;
  const root = document.documentElement;
  if (heading) root.dataset.vt = heading;
  const done = () => {
    running = false;
    delete root.dataset.vt;
  };
  try {
    d.startViewTransition(() => flushSync(fn)).finished.finally(done);
  } catch {
    done();
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
