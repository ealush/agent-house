/**
 * Runs `fn` every `ms` while the page is visible; returns the stop function.
 * A backgrounded tab (or a phone with the screen off) polls nothing, which
 * costs the host a git or tmux call each time, and catches up the moment it
 * is visible again instead of waiting out the interval.
 */
export function every(ms: number, fn: () => unknown): () => void {
  let missed = false;
  const timer = window.setInterval(() => {
    if (document.visibilityState === 'hidden') missed = true;
    else void fn();
  }, ms);
  const back = () => {
    if (document.visibilityState !== 'visible' || !missed) return;
    missed = false;
    void fn();
  };
  document.addEventListener('visibilitychange', back);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', back);
  };
}
