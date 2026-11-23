import { sessionLink } from './sessionKeys.ts';

type SelectionSource = {
  getSelection(): string;
  onSelectionChange(listener: () => void): { dispose(): void };
};

/** Best-effort clipboard write. The async Clipboard API is missing on plain-http
 *  origins (LAN / Tailscale); there a hidden textarea plus execCommand still
 *  copies within the user's selection gesture. Never rejects. */
export function copyText(text: string, target?: Pick<Clipboard, 'writeText'> | undefined | null): Promise<boolean> {
  const clip = target ?? (globalThis as unknown as { navigator?: Navigator }).navigator?.clipboard;
  if (clip?.writeText) return clip.writeText(text).then(
    () => true,
    () => legacyCopy(text),
  );
  return Promise.resolve(legacyCopy(text));
}

/** A session's link on the clipboard (to paste into another session's box), and a word that it's there. */
export function copySessionLink(key: string): void {
  void copyText(sessionLink(key, location.origin)).then((ok) => window.dispatchEvent(new CustomEvent('ah:toast', { detail: ok ? 'Copied the link' : "Couldn't copy the link" })));
}

/** Synchronous fallback for contexts without the async Clipboard API. */
export function legacyCopy(text: string): boolean {
  try {
    const doc = (globalThis as { document?: Document }).document;
    if (!doc || typeof doc.execCommand !== 'function') return false;
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
    doc.body.appendChild(area);
    area.select();
    const ok = doc.execCommand('copy');
    area.remove();
    return ok !== false;
  } catch {
    return false;
  }
}

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
    if (text === last) return;
    const target = clipboard();
    if (!target?.writeText) {
      // No async Clipboard API here: the legacy path still copies, and `last`
      // is only kept when it actually landed so a later gesture retries.
      last = legacyCopy(text) ? text : '';
      return;
    }
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
