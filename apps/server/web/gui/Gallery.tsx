// A message's pictures as tiles, and open over the page one at a time: swipe (or drag, or
// the arrow keys) to the next, flick down or Escape to put it away. Opening grows the picture
// out of the tile you tapped; closing puts it back in the tile it's on now.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { calm } from '../motion.ts';
import { Icon } from '../icons.tsx';

export type Picture = { src: string; name: string };

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
/** Further than this along, or a flick, goes to the next one. */
const TURN = 0.18;
const FLICK = 0.45;

/**
 * A group of pictures that open together. `natural`: a lone picture at its own size (what an
 * agent drew), not a tile.
 */
export function Pictures({ pictures, natural = false }: { pictures: Picture[]; natural?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const tiles = useRef<(HTMLElement | null)[]>([]);
  if (!pictures.length) return null;
  const lone = natural && pictures.length === 1;
  const show = (i: number) => (e: MouseEvent) => {
    // ⌘/Ctrl-click (or a middle click) still opens the file in a tab of its own.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    setOpen(i);
  };
  return (
    <>
      {pictures.map((p, i) => (
        <a
          key={i}
          ref={(el) => void (tiles.current[i] = el)}
          className={lone ? 'pic lone' : 'pic'}
          href={p.src}
          target="_blank"
          rel="noreferrer noopener"
          title={p.name}
          aria-label={pictures.length > 1 ? `${p.name}, ${i + 1} of ${pictures.length}` : p.name}
          onClick={show(i)}
        >
          <img src={p.src} alt={p.name} loading="lazy" className={lone ? 'widget-img' : undefined} />
        </a>
      ))}
      {open !== null && <Gallery pictures={pictures} start={open} tile={(i) => tiles.current[i] ?? null} onClose={() => setOpen(null)} />}
    </>
  );
}

type Drag = { id: number; on: Element; x: number; y: number; axis: 'x' | 'y' | null; dx: number; dy: number; v: number; t: number; last: number };

/** The pictures over everything, the one at `start` first. `tile(i)`: where picture i sits in the page. */
export function Gallery({ pictures, start, tile, onClose }: { pictures: Picture[]; start: number; tile: (i: number) => HTMLElement | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(start);
  const atRef = useRef(at);
  atRef.current = at;
  const [chrome, setChrome] = useState(true);
  const drag = useRef<Drag | null>(null);
  const leaving = useRef(false);
  const many = pictures.length > 1;

  const img = (i: number) => track.current?.children[i]?.querySelector('img') ?? null;
  /** The track at picture `i`, `dx` along and `dy` down; eased into place unless a finger has it. */
  const place = (i: number, dx = 0, dy = 0, ease = true) => {
    const el = track.current;
    if (!el) return;
    el.style.transition = ease && !calm() ? `transform 320ms ${EASE}` : '';
    el.style.transform = `translate3d(calc(${-i * 100}% + ${dx}px), ${dy}px, 0)`;
    ref.current?.style.setProperty('--fade', String(1 - Math.min(1, Math.max(0, dy) / (innerHeight * 0.6))));
  };
  const go = (i: number) => {
    const next = Math.max(0, Math.min(pictures.length - 1, i));
    setAt(next);
    place(next);
  };

  /** From where picture `i` sits in the page to where it is here (or back): its tile's box, cropped as the tile crops it. */
  const fly = (i: number, back: boolean) => {
    const pic = img(i);
    const from = tile(i)?.getBoundingClientRect();
    if (!pic || !from || calm() || !pic.complete || !pic.naturalWidth) return null;
    const to = pic.getBoundingClientRect();
    const onScreen = from.bottom > 0 && from.top < innerHeight && from.width > 0;
    if (!onScreen || !to.width) return null;
    const s = Math.max(from.width / to.width, from.height / to.height);
    const ix = (to.width - from.width / s) / 2;
    const iy = (to.height - from.height / s) / 2;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const small = { transform: `translate(${dx}px, ${dy}px) scale(${s})`, clipPath: `inset(${iy}px ${ix}px round ${8 / s}px)` };
    const big = { transform: 'none', clipPath: 'inset(0 0 round 0)' };
    return pic.animate(back ? [big, small] : [small, big], { duration: back ? 260 : 320, easing: EASE, fill: back ? 'forwards' : 'none' });
  };

  // Put away, focus goes back to the tile it's on now, as a native dialog's would to what opened it.
  useEffect(
    () => () => {
      const now = document.activeElement;
      if (!now || now === document.body || !now.isConnected || ref.current?.contains(now)) tile(atRef.current)?.focus({ preventScroll: true });
    },
    [],
  );

  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    d.focus({ preventScroll: true });
    place(start, 0, 0, false);
    if (calm()) return;
    d.animate([{ '--fade': 0 } as Keyframe, { '--fade': 1 } as Keyframe], { duration: 240, easing: 'ease-out' });
    const pic = img(start);
    if (pic?.complete) fly(start, false);
    else pic?.animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE });
  }, []);

  const close = () => {
    if (leaving.current) return;
    leaving.current = true;
    const d = ref.current;
    if (!d || calm()) return onClose();
    const pic = img(atRef.current);
    const fade = Number(getComputedStyle(d).getPropertyValue('--fade') || 1);
    // Back into its tile from wherever the drag left it, the dark going with it.
    const a = fly(atRef.current, true) ?? pic?.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.96)' }], { duration: 200, easing: EASE, fill: 'forwards' });
    d.animate([{ '--fade': fade } as Keyframe, { '--fade': 0 } as Keyframe], { duration: 240, easing: EASE, fill: 'forwards' });
    if (a) a.finished.then(onClose, onClose);
    else onClose();
  };

  // The keys while it's open, before anything else on the page hears them.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (step) go(atRef.current + step);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(pictures.length - 1);
      else if (e.key !== 'Escape') return;
      else close();
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [pictures.length]);

  // The next and the one before load now, so a swipe lands on a picture, not on its loading.
  useEffect(() => {
    for (const i of [at - 1, at + 1]) if (pictures[i]) new Image().src = pictures[i].src;
  }, [at]);

  const down = (e: PointerEvent) => {
    if (drag.current || (e.pointerType === 'mouse' && e.button !== 0) || (e.target as Element).closest('button, a')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, on: e.target as Element, x: e.clientX, y: e.clientY, axis: null, dx: 0, dy: 0, v: 0, t: e.timeStamp, last: e.clientX };
  };
  const move = (e: PointerEvent) => {
    const g = drag.current;
    if (!g || g.id !== e.pointerId) return;
    const x = e.clientX - g.x;
    const y = e.clientY - g.y;
    if (!g.axis) {
      if (Math.hypot(x, y) < 8) return;
      g.axis = Math.abs(x) > Math.abs(y) ? 'x' : 'y';
    }
    const dt = Math.max(1, e.timeStamp - g.t);
    const along = g.axis === 'x' ? e.clientX : e.clientY;
    g.v = 0.7 * g.v + 0.3 * ((along - g.last) / dt);
    g.last = along;
    g.t = e.timeStamp;
    if (g.axis === 'x') {
      // Past the first or the last it gives, and comes back.
      const edge = (x > 0 && at === 0) || (x < 0 && at === pictures.length - 1);
      g.dx = edge ? x * 0.3 : x;
      place(at, g.dx, 0, false);
    } else {
      g.dy = y > 0 ? y : y * 0.2;
      place(at, 0, g.dy, false);
    }
  };
  const up = (e: PointerEvent) => {
    const g = drag.current;
    if (!g || g.id !== e.pointerId) return;
    drag.current = null;
    if (e.type === 'pointercancel') return place(at);
    const width = track.current?.getBoundingClientRect().width || innerWidth;
    if (g.axis === 'x') {
      const step = g.dx < -width * TURN || g.v < -FLICK ? 1 : g.dx > width * TURN || g.v > FLICK ? -1 : 0;
      return go(at + step);
    }
    if (g.axis === 'y') return g.dy > 120 || g.v > FLICK ? close() : place(at);
    // A tap: on the picture it hides what's around it (or brings it back); beside it, it closes.
    // (What the finger came down on: a captured pointer's up is the stage's.)
    if (g.on.closest('img')) setChrome((c) => !c);
    else close();
  };

  const name = pictures[at]?.name ?? '';
  return createPortal(
    <dialog
      ref={ref}
      className={`gallery ${chrome ? '' : 'bare'}`}
      aria-label={many ? `${name}, ${at + 1} of ${pictures.length}` : name}
      aria-roledescription="gallery"
      tabIndex={-1}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="gallery-stage" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div ref={track} className="gallery-track">
          {pictures.map((p, i) => (
            <div key={i} className="gallery-slide" aria-hidden={i !== at} inert={i !== at}>
              {Math.abs(i - at) <= 2 && <img src={p.src} alt={p.name} draggable={false} />}
            </div>
          ))}
        </div>
      </div>
      <div className="gallery-bar">
        <span className="gallery-name" title={name}>{name}</span>
        {many && (
          <span className="gallery-count" aria-hidden>
            {at + 1} / {pictures.length}
          </span>
        )}
        <a className="gallery-btn" href={pictures[at]?.src} target="_blank" rel="noreferrer noopener" aria-label="Open in a new tab" title="Open in a new tab">
          <Icon name="external" size={18} />
        </a>
        <button type="button" className="gallery-btn" onClick={close} aria-label="Close" title="Close (Esc)">
          <Icon name="close" size={18} />
        </button>
      </div>
      {many && (
        <>
          <button type="button" className="gallery-btn gallery-step prev" onClick={() => go(at - 1)} disabled={at === 0} aria-label="Previous picture" title="Previous (←)">
            <Icon name="chevron-right" size={20} />
          </button>
          <button type="button" className="gallery-btn gallery-step next" onClick={() => go(at + 1)} disabled={at === pictures.length - 1} aria-label="Next picture" title="Next (→)">
            <Icon name="chevron-right" size={20} />
          </button>
          <div className="gallery-dots" role="tablist" aria-label="Pictures" hidden={pictures.length > 12}>
            {pictures.map((p, i) => (
              <button key={i} type="button" role="tab" aria-selected={i === at} aria-label={`${p.name}, ${i + 1} of ${pictures.length}`} className={i === at ? 'on' : ''} onClick={() => go(i)} />
            ))}
          </div>
        </>
      )}
    </dialog>,
    document.body,
  );
}
