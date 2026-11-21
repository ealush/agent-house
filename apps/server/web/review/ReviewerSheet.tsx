import { useEffect, useRef, useState, type ReactNode } from 'react';
import { calm } from '../motion.ts';

type Detent = 'half' | 'full';

/**
 * The reviewer on a phone: a sheet that rises to half the screen, so the
 * finding or the lines you asked about stay in view above it, and pulls up to
 * the full height to read a long answer. Drag its top (or tap the grabber) to
 * move between the two; drag it down from half, or tap above it, to put it away.
 * It sits over the keyboard's top edge while you type (viewport.ts --vh).
 */
export function ReviewerSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [detent, setDetent] = useState<Detent>('half');
  const [leaving, setLeaving] = useState(false);
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null);

  const close = () => {
    if (calm()) return onClose();
    setLeaving(true);
    setTimeout(onClose, 220);
  };

  // Escape puts it away, as a dialog's would.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) close();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const start = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // From its top only: the conversation under it scrolls.
    const t = e.target as Element;
    if (!t.closest('.rs-grabber, .reviewer-head') || t.closest('.reviewer-head button, .reviewer-head a')) return;
    drag.current = { y: e.clientY, t: performance.now(), dy: 0 };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el) return;
    d.dy = e.clientY - d.y;
    // Up past full, or a few px either way, isn't a drag yet.
    const dy = detent === 'full' ? Math.max(0, d.dy) : d.dy;
    if (Math.abs(dy) < 6) return;
    el.style.transition = 'none';
    el.style.transform = `translate3d(0, ${dy}px, 0)`;
  };
  const end = () => {
    const d = drag.current;
    const el = ref.current;
    drag.current = null;
    if (!d || !el) return;
    el.style.transition = '';
    el.style.transform = '';
    const fast = Math.abs(d.dy) / Math.max(1, performance.now() - d.t) > 0.5;
    if (Math.abs(d.dy) < 6) return;
    if (d.dy < 0 && (d.dy < -60 || fast)) setDetent('full');
    else if (d.dy > 0 && (d.dy > 80 || fast)) detent === 'full' ? setDetent('half') : close();
  };

  return (
    <>
      <div className={`rs-scrim ${detent} ${leaving ? 'leaving' : ''}`} aria-hidden onClick={close} />
      <section
        ref={ref}
        className={`reviewer-sheet ${detent} ${leaving ? 'leaving' : ''}`}
        aria-label="Reviewer"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <button type="button" className="rs-grabber" aria-label={detent === 'half' ? 'Pull the reviewer up' : 'Lower the reviewer'} onClick={() => setDetent(detent === 'half' ? 'full' : 'half')}>
          <span aria-hidden />
        </button>
        {children}
      </section>
    </>
  );
}
