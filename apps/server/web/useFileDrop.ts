import { useEffect, useRef, useState, type DragEvent } from 'react';

/** Files dropped onto an element: whether a file drag is over it now, and the
 *  handlers to spread on it.
 *
 *  The drop hint must never outlive the drag. A drag that leaves through a child
 *  (xterm's canvas, a feed bubble), past the window's edge, or is cancelled with
 *  Esc may never fire a dragleave on the element itself, which left the hint
 *  covering the pane until a reload. So the hint also goes once dragover stops
 *  arriving: browsers repeat it every few hundred ms while a drag hovers. */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [over, setOver] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const clear = () => {
    window.clearTimeout(timer.current);
    setOver(false);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!enabled) clear();
  }, [enabled]);

  const handlers = {
    onDragOver(e: DragEvent<HTMLElement>) {
      if (!enabled || !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setOver(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setOver(false), 700);
    },
    onDragLeave(e: DragEvent<HTMLElement>) {
      // Into a child is still over; out of the element (or the window) is not.
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) clear();
    },
    onDrop(e: DragEvent<HTMLElement>) {
      clear();
      if (!enabled || !e.dataTransfer.files.length) return;
      e.preventDefault();
      onFiles([...e.dataTransfer.files]);
    },
  };
  return { over, handlers };
}
