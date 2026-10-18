import { useEffect, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from './icons.tsx';

export type SwipeAction = { label: string; icon: IconName; tone?: 'danger' | 'accent' | 'plain'; run: () => void };

const TOUCH = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
/** Each action's width, as iOS's. */
const W = 76;
/** Past this share of the row, letting go runs the outermost action (a full swipe). */
const FULL = 0.6;

// One row open at a time, as in Mail: opening another, or touching anything else, closes it.
let openRow: (() => void) | null = null;
if (TOUCH && typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (openRow && !(e.target as Element | null)?.closest('.swipe.open')) openRow();
    },
    { capture: true, passive: true },
  );
}

/** Moves a row's front to `to` (px, ≤ 0) and marks how far its actions show. */
function place(box: HTMLElement | null, front: HTMLElement | null, to: number, max: number, animate: boolean) {
  if (!box || !front) return;
  front.style.transition = animate ? 'transform 260ms cubic-bezier(0.32, 0.72, 0, 1)' : 'none';
  front.style.transform = to ? `translateX(${to}px)` : '';
  box.style.setProperty('--shown', String(Math.min(1, -to / max)));
  box.classList.toggle('open', to < 0);
  box.classList.toggle('full', -to > box.offsetWidth * FULL);
}

/**
 * A list row whose actions a finger swipes out from its trailing edge, as in Mail:
 * swipe left and they show (it stays open past half of them); keep going past 60% of
 * the row and letting go runs the outermost one. A tap on an open row closes it.
 * Only a sideways drag counts; a vertical one stays the list's scroll (touch-action:
 * pan-y). Touch screens only: elsewhere the row is as it was.
 */
export function Swipe({ actions, children }: { actions: SwipeAction[]; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const front = useRef<HTMLDivElement>(null);
  const x = useRef(0);
  const max = actions.length * W;
  // The finger's drag, kept across the list's re-renders (it refreshes every second).
  const drag = useRef<{ x: number; y: number; from: number; sideways: boolean } | null>(null);
  const swiped = useRef(false);
  // One close per row for its life, so "the open row" is still this row after a render.
  const closeRef = useRef<(() => void) | null>(null);
  if (!closeRef.current) {
    const close = () => {
      x.current = 0;
      place(box.current, front.current, 0, 1, true);
      if (openRow === close) openRow = null;
    };
    closeRef.current = close;
  }
  const close = closeRef.current;
  useEffect(
    () => () => {
      if (openRow === close) openRow = null;
    },
    [close],
  );
  if (!TOUCH || actions.length === 0) return <>{children}</>;

  const set = (to: number, animate: boolean) => {
    x.current = to;
    place(box.current, front.current, to, max, animate);
  };

  return (
    <div className="swipe" ref={box}>
      <div className="swipe-actions">
        {actions.map((a, i) => (
          <button
            key={a.label}
            type="button"
            tabIndex={-1}
            className={`swipe-act ${a.tone ?? 'plain'} ${i === actions.length - 1 ? 'outer' : ''}`}
            onClick={() => {
              close();
              a.run();
            }}
          >
            <Icon name={a.icon} size={20} />
            <span>{a.label}</span>
          </button>
        ))}
      </div>
      <div
        className="swipe-front"
        ref={front}
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch') return;
          if (openRow && openRow !== close) openRow();
          drag.current = { x: e.clientX, y: e.clientY, from: x.current, sideways: false };
          swiped.current = false;
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.sideways) {
            if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return void (drag.current = null);
            if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
            // No pointer capture: a touch already stays with the row, and the row's own
            // listeners (its held-finger menu, contextMenu.ts) must see the move to let go.
            d.sideways = true;
            swiped.current = true;
          }
          // Past the actions it goes on, a little slower, toward a full swipe; never to the right.
          const width = box.current?.offsetWidth ?? 360;
          let to = Math.min(0, d.from + dx);
          if (to < -max) to = -max + (to + max) * 0.85;
          set(Math.max(to, -width), false);
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (!d?.sideways) return;
          const width = box.current?.offsetWidth ?? 360;
          if (-x.current > width * FULL) {
            const outer = actions[actions.length - 1];
            set(-width, true);
            window.setTimeout(() => {
              close();
              outer.run();
            }, 200);
          } else if (-x.current > max / 2) {
            set(-max, true);
            openRow = close;
          } else close();
        }}
        onPointerCancel={() => {
          if (drag.current?.sideways) close();
          drag.current = null;
        }}
        onClickCapture={(e) => {
          // A swipe isn't a tap, and a tap on an open row only closes it.
          if (swiped.current || x.current < 0) {
            e.preventDefault();
            e.stopPropagation();
            swiped.current = false;
            if (x.current < 0) close();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
