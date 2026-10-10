// ⌘↵ / Ctrl+↵ confirms. Main buttons register themselves while mounted
// (ConfirmButton.tsx); the key presses the newest one in the current context:
// the open dialog, or the screen (`data-confirm`) the keyboard is in. Runs
// after component handlers, so anything that owns Ctrl+↵ itself (a question
// form, a diff comment, the switcher) wins, and a terminal keeps the key.

const live = new Set<HTMLButtonElement>();

/** Called by a confirm button as it mounts; returns the unregister. */
export function registerConfirm(button: HTMLButtonElement): () => void {
  live.add(button);
  return () => {
    live.delete(button);
  };
}

const usable = (b: HTMLButtonElement) => !b.disabled && b.isConnected && b.getClientRects().length > 0 && !b.closest('[hidden], .hidden');

/** The confirm button ⌘↵ would press for a key aimed at `target`, if any. */
export function primaryButton(target: HTMLElement | null, root: Document = document): HTMLButtonElement | null {
  if (target?.closest('.xterm')) return null;
  const buttons = [...live].filter(usable);
  // A modal dialog makes the rest inert: the newest open one is the context.
  const dialog = [...root.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);
  if (dialog) return buttons.findLast((b) => dialog.contains(b)) ?? null;
  // A screen (New session in the main area or a pane) when the keyboard is in it, or nowhere in particular.
  const idle = !target || target === root.body || target === root.documentElement;
  return buttons.findLast((b) => {
    const scope = b.closest('[data-confirm]');
    return !!scope && (idle || scope.contains(target));
  }) ?? null;
}

export function confirmKey(e: KeyboardEvent) {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.defaultPrevented || e.isComposing) return;
  const button = primaryButton(e.target as HTMLElement | null);
  if (!button) return;
  e.preventDefault();
  e.stopPropagation();
  button.click();
}
