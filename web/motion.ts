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
