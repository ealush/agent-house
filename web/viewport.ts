// CSS 100dvh owns the normal app height. Only override it for a software
// keyboard: a smaller visual viewport can also be browser chrome or pinch zoom.
// https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport
export function keyboardViewportHeight(layoutHeight: number, visualHeight: number, scale: number, editing: boolean): number | null {
  if (!editing || !Number.isFinite(visualHeight) || visualHeight <= 0 || Math.abs(scale - 1) > 0.05) return null;
  // Normal browser/safe-area differences are much smaller than a docked keyboard.
  if (layoutHeight - visualHeight < 120) return null;
  return visualHeight;
}

export function trackViewport(win: Window, doc: Document): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};
  const root = doc.documentElement;
  let frame: number | null = null;
  const update = () => {
    frame = null;
    const active = doc.activeElement as HTMLElement | null;
    const editing = !!active && (active.isContentEditable || active.matches(
      'textarea, input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"])',
    ));
    const height = keyboardViewportHeight(root.clientHeight, viewport.height, viewport.scale, editing);
    if (height === null) root.style.removeProperty('--vh');
    else root.style.setProperty('--vh', `${height}px`);
  };
  // Read fresh dimensions after the browser has applied resize/focus changes.
  const schedule = () => {
    if (frame === null) frame = win.requestAnimationFrame(update);
  };
  update();
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  win.addEventListener('resize', schedule);
  win.addEventListener('pageshow', schedule);
  doc.addEventListener('focusin', schedule);
  doc.addEventListener('focusout', schedule);
  return () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    viewport.removeEventListener('resize', schedule);
    viewport.removeEventListener('scroll', schedule);
    win.removeEventListener('resize', schedule);
    win.removeEventListener('pageshow', schedule);
    doc.removeEventListener('focusin', schedule);
    doc.removeEventListener('focusout', schedule);
    root.style.removeProperty('--vh');
  };
}
