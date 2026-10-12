import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { calm } from './motion.ts';
import { Icon } from './icons.tsx';

/** A phone, portrait or sideways: the same query as App's `narrow` and styles.css. */
export const PHONE = '(max-width: 760px), ((pointer: coarse) and (max-height: 500px) and (max-width: 1000px))';
const phone = () => matchMedia(PHONE).matches;

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

/**
 * A modal on a phone, the iPhone way: it covers the screen, rises from the
 * bottom (styles.css `sheet-rise`), and goes back down when you drag it down,
 * from its grabber bar anywhere, or from its content once that is scrolled to
 * the top. Short of a quarter of the screen (and not a flick) it settles back.
 *
 * `dismiss` is the same exit for the close button: down, then `onClose`.
 * On a desktop both are just `onClose`; confirmation dialogs stay centered and
 * don't use this.
 */
export function useSheet(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  const leaving = useRef(false);

  const dismiss = () => {
    const el = ref.current;
    if (leaving.current) return;
    if (!el || !phone() || calm()) return close.current();
    leaving.current = true;
    const from = getComputedStyle(el).transform;
    const a = el.animate([{ transform: from === 'none' ? 'translate3d(0, 0, 0)' : from }, { transform: 'translate3d(0, 100%, 0)' }], { duration: 280, easing: EASE, fill: 'forwards' });
    el.style.setProperty('--drag', '1');
    a.finished.then(() => close.current(), () => close.current());
  };
  const out = useRef(dismiss);
  out.current = dismiss;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let start: { x: number; y: number; t: number } | null = null;
    let engaged = false;
    let dy = 0;
    let height = 1;

    // Content scrolled down scrolls back up first; only at the top does the sheet move.
    const atTop = (target: Element | null) => {
      for (let n = target; n && n !== el.parentElement; n = n.parentElement) if (n.scrollTop > 0) return false;
      return true;
    };
    const reset = () => {
      el.style.transform = '';
      el.style.transition = '';
      el.style.removeProperty('--drag');
    };

    const onStart = (e: TouchEvent) => {
      start = null;
      if (leaving.current || e.touches.length !== 1 || !phone()) return;
      const target = e.target as Element | null;
      if (target?.closest('.term, input[type="range"], .no-sheet-drag')) return;
      if (!target?.closest('.sheet-bar') && !atTop(target)) return;
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, t: performance.now() };
      engaged = false;
      dy = 0;
    };

    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      const x = t.clientX - start.x;
      const y = t.clientY - start.y;
      if (!engaged) {
        // Up, or sideways: a scroll or a swipe of something inside, not this.
        if (y < -4 || Math.abs(x) > Math.abs(y) + 4) {
          start = null;
          return;
        }
        if (y < 8) return;
        engaged = true;
        height = el.getBoundingClientRect().height || 1;
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      e.preventDefault();
      dy = Math.max(0, y);
      el.style.transform = `translate3d(0, ${dy}px, 0)`;
      el.style.setProperty('--drag', String(Math.min(1, dy / height)));
    };

    const onEnd = () => {
      if (!start) return;
      const was = start;
      start = null;
      if (!engaged) return;
      engaged = false;
      const speed = dy / Math.max(1, performance.now() - was.t);
      if (dy > height / 4 || (speed > 0.5 && dy > 40)) return out.current();
      if (calm()) return reset();
      el.style.transition = `transform 260ms ${EASE}`;
      el.style.transform = 'translate3d(0, 0, 0)';
      el.style.setProperty('--drag', '0');
      setTimeout(reset, 280);
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [ref]);

  return { dismiss };
}

/**
 * The top of a phone sheet: a grabber to drag it down by, and a close button.
 * Desktop dialogs have their own Cancel, so it shows only on a phone (styles.css).
 */
export function SheetBar({ onClose, title }: { onClose: () => void; title?: string }) {
  return (
    <div className="sheet-bar">
      <span className="grabber" aria-hidden />
      {title && <span className="sheet-title">{title}</span>}
      <button type="button" className="icon-btn sheet-x" onClick={onClose} aria-label="Close">
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}

/**
 * A whole view presented as a phone sheet (Settings): a modal dialog of its
 * own that scrolls inside, with the sheet's bar on top.
 */
export function Sheet({ label, className = '', onClose, children }: { label: string; className?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(ref, onClose);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog sheet-view ${className}`}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
    >
      <SheetBar onClose={dismiss} title={label} />
      {children}
    </dialog>
  );
}
