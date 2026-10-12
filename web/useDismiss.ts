import { useEffect, useRef, type RefObject } from 'react';

/**
 * Close an open menu the way a native one closes: a tap or click anywhere
 * outside it, or Escape. Leaving it with the mouse is not enough on a touch
 * screen, where there is no mouse to leave.
 */
export function useDismiss(open: boolean, inside: RefObject<HTMLElement | null>, close: () => void) {
  const done = useRef(close);
  done.current = close;
  useEffect(() => {
    const close = () => done.current();
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (inside.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, inside]);
}
