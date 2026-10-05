type SelectionSource = {
  getSelection(): string;
  onSelectionChange(listener: () => void): { dispose(): void };
};

/** Copy completed terminal selections, preserving the range for normal copy shortcuts. */
export function autoCopySelection(
  element: EventTarget & { ownerDocument: EventTarget },
  terminal: SelectionSource,
  clipboard: () => Pick<Clipboard, 'writeText'> | undefined,
): () => void {
  let dragging = false;
  let last = '';
  const copy = () => {
    const text = terminal.getSelection();
    if (!text) { last = ''; return; }
    const target = clipboard();
    if (text === last || !target?.writeText) return;
    last = text;
    try {
      target.writeText(text).catch(() => { if (last === text) last = ''; });
    } catch {
      last = '';
    }
  };
  const start = () => { dragging = true; };
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    copy();
  };
  const subscription = terminal.onSelectionChange(() => { if (!dragging) copy(); });
  element.addEventListener('pointerdown', start);
  element.ownerDocument.addEventListener('pointerup', finish);
  element.ownerDocument.addEventListener('pointercancel', finish);
  element.addEventListener('keyup', copy);
  element.addEventListener('touchend', finish);
  return () => {
    subscription.dispose();
    element.removeEventListener('pointerdown', start);
    element.ownerDocument.removeEventListener('pointerup', finish);
    element.ownerDocument.removeEventListener('pointercancel', finish);
    element.removeEventListener('keyup', copy);
    element.removeEventListener('touchend', finish);
  };
}
