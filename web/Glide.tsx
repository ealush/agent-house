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
  const place = () => {
    const m = ref.current;
    const box = m?.parentElement;
    if (!m || !box) return;
    const el = box.querySelector<HTMLElement>(match);
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
    if (arriving) m.classList.add('placing');
    m.style.transform = next;
    m.style.width = size[0];
    m.style.height = size[1];
    m.classList.add('shown');
    if (arriving) {
      void m.offsetWidth;
      m.classList.remove('placing');
    }
  };
  // Every render of the list: the selection, order or contents may have moved.
  useLayoutEffect(place);
  useLayoutEffect(() => {
    const box = ref.current?.parentElement;
    if (!box) return;
    box.classList.add('glides');
    const ro = new ResizeObserver(() => place());
    ro.observe(box);
    return () => {
      ro.disconnect();
      box.classList.remove('glides');
    };
  }, []);
  return <span ref={ref} className={`glide ${className}`} aria-hidden />;
}
