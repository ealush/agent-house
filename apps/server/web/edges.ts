// The screen's side edges are ah's, not the browser's. iOS (Safari, and an app on
// the home screen) answers a drag in from an edge with its own Back/Forward: a
// snapshot of the last page slides in under a moving copy of this one, and then
// ah's own transition plays on the popstate. With ah's swipe back (useSwipeBack)
// both ran at once: two pages under the session, and a landing that played twice.
//
// iOS only lets a page keep that gesture by cancelling the touchstart itself
// (Safari 13.4+). That also cancels what the browser does with the touch, so a
// touch that starts in an edge strip gets it back here: a tap clicks what's under
// it, and a drag scrolls what it's on (a list, a strip of tabs), with momentum after a flick.
// Swipes, the terminal and sheets handle their touches themselves, as before.

/** How far in from either side the browser's own swipe is kept off (and useSwipeBack starts). */
export const EDGE = 28;

/** A tap moves less than this and lifts within TAP_MS. */
const TAP = 10;
const TAP_MS = 500;

// When the last touch from an edge was down: a popstate soon after came from a
// swipe that has already shown the way back (see edgeGesture).
let edgeAt = -Infinity;
let down = false;
let fromEdge: { x: number; y: number } | null = null;

/**
 * A finger from a screen edge is down, or dragged and lifted a moment ago. If the browser's
 * swipe ever gets through regardless, the popstate it ends with must not animate
 * the same step a second time.
 */
export function edgeGesture(): boolean {
  return down || performance.now() - edgeAt < 1000;
}

const typing = 'input, textarea, select, [contenteditable]';

/** The nearest box that scrolls along this axis, from what was pressed out. */
function scroller(from: Element, sideways: boolean): HTMLElement | null {
  for (let el: Element | null = from; el && el !== document.documentElement; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    if (sideways ? el.scrollWidth <= el.clientWidth + 1 : el.scrollHeight <= el.clientHeight + 1) continue;
    const o = getComputedStyle(el)[sideways ? 'overflowX' : 'overflowY'];
    if (o === 'auto' || o === 'scroll') return el;
  }
  return sideways ? null : (document.scrollingElement as HTMLElement | null);
}

let installed = false;

export function installEdges() {
  if (installed) return;
  installed = true;
  type Touch = { id: number; x: number; y: number; t: number; last: number; lastT: number; v: number; target: Element; box: HTMLElement | null; axis: 'x' | 'y' | null };
  let touch: Touch | null = null;
  let glide: number | null = null;
  const stopGlide = () => {
    if (glide !== null) cancelAnimationFrame(glide);
    glide = null;
  };

  window.addEventListener(
    'touchstart',
    (e) => {
      stopGlide();
      if (e.touches.length !== 1) return void (touch = null);
      const t = e.touches[0];
      const target = e.target as Element | null;
      fromEdge = target && (t.clientX <= EDGE || t.clientX >= window.innerWidth - EDGE) ? { x: t.clientX, y: t.clientY } : null;
      if (!target || !fromEdge) return void (touch = null);
      down = true;
      // A text field keeps its caret and selection; the browser's swipe can have that strip.
      if (target.closest(typing) || !e.cancelable) return void (touch = null);
      e.preventDefault();
      touch = { id: t.identifier, x: t.clientX, y: t.clientY, t: e.timeStamp, last: 0, lastT: e.timeStamp, v: 0, target, box: null, axis: null };
    },
    { capture: true, passive: false },
  );

  // Bubble phase: a touchmove someone else took (a swipe stops it; the terminal and
  // sheets cancel it) is theirs.
  window.addEventListener(
    'touchmove',
    (e) => {
      if (!touch || e.defaultPrevented) return;
      const t = [...e.touches].find((p) => p.identifier === touch!.id);
      if (!t) return;
      if (!touch.axis) {
        const dx = Math.abs(t.clientX - touch.x);
        const dy = Math.abs(t.clientY - touch.y);
        if (Math.max(dx, dy) < TAP) return;
        touch.axis = dx > dy ? 'x' : 'y';
        touch.box = scroller(touch.target, touch.axis === 'x');
        touch.last = touch.axis === 'x' ? touch.x : touch.y;
      }
      const at = touch.axis === 'x' ? t.clientX : t.clientY;
      const dt = Math.max(1, e.timeStamp - touch.lastT);
      const step = at - touch.last;
      touch.v = 0.7 * touch.v + 0.3 * (step / dt);
      touch.last = at;
      touch.lastT = e.timeStamp;
      scrollAlong(touch.box, touch.axis, -step);
    },
    { passive: true },
  );

  const scrollAlong = (box: HTMLElement | null, axis: 'x' | 'y', by: number) => box?.scrollBy(axis === 'x' ? by : 0, axis === 'y' ? by : 0);

  const end = (e: TouchEvent) => {
    if (!e.touches.length && fromEdge) {
      // A tap (the Back chevron, say) is no swipe: its step animates as ever.
      const t = e.changedTouches[0];
      if (t && Math.hypot(t.clientX - fromEdge.x, t.clientY - fromEdge.y) >= TAP) edgeAt = performance.now();
      down = false;
      fromEdge = null;
    }
    if (!touch) return;
    const s = touch;
    const t = [...e.changedTouches].find((p) => p.identifier === s.id);
    if (!t) return;
    touch = null;
    if (e.type !== 'touchend') return;
    if (s.axis) {
      // A flick keeps going and slows down, like the browser's own scrolling.
      const { box, axis } = s;
      if (!box || Math.abs(s.v) < 0.25 || e.timeStamp - s.lastT > 80) return;
      let v = s.v;
      let prev = performance.now();
      const tick = (now: number) => {
        const dt = Math.min(48, now - prev);
        prev = now;
        scrollAlong(box, axis, -v * dt);
        v *= Math.pow(0.995, dt);
        glide = Math.abs(v) > 0.03 ? requestAnimationFrame(tick) : null;
      };
      glide = requestAnimationFrame(tick);
      return;
    }
    const moved = Math.hypot(t.clientX - s.x, t.clientY - s.y);
    if (moved >= TAP || e.timeStamp - s.t > TAP_MS || !s.target.isConnected) return;
    // The click the cancelled touchstart took away, on what was pressed.
    s.target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, detail: 1, clientX: t.clientX, clientY: t.clientY, screenX: t.screenX, screenY: t.screenY }));
  };
  // Bubble phase too: a swipe back that took the touch (useSwipeBack) has ended it by then.
  window.addEventListener('touchend', end);
  window.addEventListener('touchcancel', end);
}
