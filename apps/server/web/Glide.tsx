import { useLayoutEffect, useRef } from 'react';

/**
 * The selection highlight, as one thing that moves: it slides from the item
 * you were on to the one you picked (sidebar rows, tabs, segments), the way
 * iOS moves a segmented control's thumb, so the eye follows the change.
 *
 * Put it first inside the list. It finds the item matching `match` in its
 * parent and sits behind it; the item itself draws no background (styles.css
 * `.glides`). It follows the item as rows reorder, resize or scroll with the list.
 */
export function Glide({ match, className = '' }: { match: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const mounted = useRef(false);
  const on = useRef<HTMLElement | null>(null);
  const place = () => {
    const m = ref.current;
    const box = m?.parentElement;
    if (!m || !box) return;
    // A list that mounts with an item already on (a page swiped back to) shows it at once.
    const first = !mounted.current;
    mounted.current = true;
    // A finger sliding along the control (slide.ts) holds the thumb under it until it lifts.
    const el = box.querySelector<HTMLElement>(':scope > [data-held]') ?? box.querySelector<HTMLElement>(match);
    on.current = el;
    if (!el || el.offsetParent === null) {
      m.classList.remove('shown');
      return;
    }
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const x = r.left - b.left - box.clientLeft + box.scrollLeft;
    const y = r.top - b.top - box.clientTop + box.scrollTop;
    const next = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    const size = [`${Math.round(r.width)}px`, `${Math.round(r.height)}px`];
    if (m.style.transform === next && m.style.width === size[0] && m.style.height === size[1] && m.classList.contains('shown')) return;
    // Appearing (nothing was selected here): start where the item is, and only fade in.
    const arriving = !m.classList.contains('shown');
    if (arriving) m.classList.add(first ? 'still' : 'placing');
    m.style.transform = next;
    m.style.width = size[0];
    m.style.height = size[1];
    m.classList.add('shown');
    if (arriving) {
      void m.offsetWidth;
      m.classList.remove('placing', 'still');
    }
  };
  const placeRef = useRef(place);
  placeRef.current = place;
  // When the selection moves (an item gains or loses `match`), the items change or reorder,
  // or the list resizes; not on every render of a list that re-renders each tick, where
  // measuring the layout each time cost a forced layout per render.
  useLayoutEffect(() => {
    placeRef.current();
  }, [match]);
  useLayoutEffect(() => {
    const box = ref.current?.parentElement;
    if (!box) return;
    box.classList.add('glides');
    const again = () => placeRef.current();
    const ro = new ResizeObserver(again);
    ro.observe(box);
    const mo = new MutationObserver((changes) => {
      for (const c of changes) {
        const t = c.target as HTMLElement;
        if (c.type === 'childList' || t === on.current || t.matches?.(match)) return again();
      }
    });
    mo.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-current', 'aria-selected', 'aria-checked', 'aria-pressed', 'data-held'] });
    box.addEventListener('ah:held', again);
    return () => {
      ro.disconnect();
      mo.disconnect();
      box.removeEventListener('ah:held', again);
      box.classList.remove('glides');
    };
  }, [match]);
  return <span ref={ref} className={`glide ${className}`} aria-hidden />;
}
