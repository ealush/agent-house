// Slide to choose, on every segmented control and toggle, the way iOS's do (and
// the phone's tab bar, which has its own: TabBar.tsx). Press a segment and slide:
// the thumb follows the finger (or the mouse) to the segment under it, and lifting
// picks that one, a click on it as a tap would be. A tap is still a tap.
//
// One listener for the whole page, so a control needs nothing but its class. A
// strip that scrolls sideways (the session's tabs on a small phone) slides only
// from the segment that's on, as iOS drags a thumb; a drag anywhere else scrolls
// it. A drag that is mostly up or down is the page's.

/** The controls that slide: their direct child buttons are the segments. */
const SLIDERS = '.seg, .seg-tabs, .view-toggle, .side-panel .tabs-scroll, .settings-nav';
/** How far a press moves sideways before it is a slide and not a tap. */
const START = 6;
/** How far above or below the control a finger can stray and still pick. */
const SLOP = 40;

type Slide = {
  box: HTMLElement;
  id: number;
  x: number;
  y: number;
  sliding: boolean;
  held: HTMLButtonElement | null;
};

const isOn = (b: Element) =>
  b.classList.contains('on') || ['aria-pressed', 'aria-selected', 'aria-checked'].some((a) => b.getAttribute(a) === 'true');

const scrolls = (box: HTMLElement) => box.scrollWidth > box.clientWidth + 1;

const segments = (box: HTMLElement) => [...box.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)')];

/** The segment nearest the pointer (a control may wrap to two rows), or none once it strays well off it. */
function segmentAt(box: HTMLElement, x: number, y: number): HTMLButtonElement | null {
  const r = box.getBoundingClientRect();
  if (y < r.top - SLOP || y > r.bottom + SLOP) return null;
  let best: HTMLButtonElement | null = null;
  let gap = Infinity;
  for (const b of segments(box)) {
    const s = b.getBoundingClientRect();
    const dx = x < s.left ? s.left - x : x > s.right ? x - s.right : 0;
    const dy = y < s.top ? s.top - y : y > s.bottom ? y - s.bottom : 0;
    const d = Math.hypot(dx, dy);
    if (d < gap) [best, gap] = [b, d];
  }
  return best;
}

function hold(slide: Slide, b: HTMLButtonElement | null) {
  if (slide.held === b) return;
  slide.held?.removeAttribute('data-held');
  slide.held = b;
  if (b) {
    b.setAttribute('data-held', '');
    // At a scrolling strip's edge, the next segment comes into view.
    b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  // The thumb (Glide.tsx) moves to the held segment, or back to the one that's on.
  slide.box.dispatchEvent(new Event('ah:held'));
}

let installed = false;

export function installSlide() {
  if (installed) return;
  installed = true;
  let slide: Slide | null = null;
  // A slide picks on lift; the click the browser sends after that same press is dropped.
  let picked = 0;

  const end = () => {
    if (!slide) return;
    const s = slide;
    slide = null;
    s.box.classList.remove('sliding');
    hold(s, null);
  };

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || !e.isPrimary) return;
      const target = e.target as Element | null;
      const box = target?.closest<HTMLElement>(SLIDERS);
      const start = target?.closest('button');
      if (!box || !start || start.parentElement !== box || (start as HTMLButtonElement).disabled) return;
      if (scrolls(box) && !isOn(start)) return;
      end();
      slide = { box, id: e.pointerId, x: e.clientX, y: e.clientY, sliding: false, held: null };
    },
    true,
  );

  document.addEventListener(
    'pointermove',
    (e) => {
      if (!slide || e.pointerId !== slide.id) return;
      if (!slide.sliding) {
        const dx = Math.abs(e.clientX - slide.x);
        const dy = Math.abs(e.clientY - slide.y);
        if (dy > START && dy > dx) return end();
        if (dx < START) return;
        slide.sliding = true;
        slide.box.classList.add('sliding');
      }
      hold(slide, segmentAt(slide.box, e.clientX, e.clientY));
    },
    true,
  );

  // A press on the thumb of a strip that scrolls is the thumb's, not the strip's: the
  // strip holds still under it. (Elsewhere, controls that don't scroll take sideways
  // drags by touch-action, styles.css, and leave up and down to the page.)
  document.addEventListener(
    'touchstart',
    (e) => {
      const target = e.target as Element | null;
      const box = target?.closest<HTMLElement>(SLIDERS);
      const start = target?.closest('button');
      if (box && start?.parentElement === box && scrolls(box) && isOn(start) && e.cancelable) e.preventDefault();
    },
    { capture: true, passive: false },
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (slide?.sliding && e.cancelable) e.preventDefault();
    },
    { capture: true, passive: false },
  );

  const lift = (e: PointerEvent) => {
    if (!slide || e.pointerId !== slide.id) return;
    const s = slide;
    const b = s.sliding && e.type === 'pointerup' ? segmentAt(s.box, e.clientX, e.clientY) : null;
    end();
    if (!s.sliding) return;
    picked = performance.now();
    if (b && !isOn(b)) b.click();
  };
  document.addEventListener('pointerup', lift, true);
  document.addEventListener('pointercancel', lift, true);

  document.addEventListener(
    'click',
    (e) => {
      // Only the click that comes with the lift itself: a finger that moved sends none,
      // and the next tap is a tap.
      if (e.detail > 0 && performance.now() - picked < 80 && (e.target as Element | null)?.closest(SLIDERS)) {
        picked = 0;
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true,
  );
}
