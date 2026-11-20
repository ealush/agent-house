// Arrow keys between the items of a list: menus, pickers, the sidebar, inbox rows,
// queued messages. A container opts in with `data-rove` (its value, when set, is
// the item selector); Tab still moves in and out of it as usual. Runs after
// component handlers, so a list with its own keys (the question form) wins.

const ITEMS = 'button, a[href], [tabindex="0"]';

/** The container's item selector; a bare `data-rove` (React renders it "true") means the default. */
const selector = (box: HTMLElement) => (box.dataset.rove && box.dataset.rove !== 'true' ? box.dataset.rove : ITEMS);

function items(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(selector(box))].filter(
    (el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0 && el.closest('[data-rove]') === box,
  );
}

export function roveKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const target = e.target as HTMLElement | null;
  if (!target || target.closest('input, textarea, select, [contenteditable="true"], .xterm')) return;
  if (pickKey(e, target)) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  // Nothing focused (a page just opened from the keyboard): the arrows go into the page's list.
  const box = target === document.body ? pageList() : target.closest<HTMLElement>('[data-rove]');
  if (!box) return;
  const list = items(box);
  if (!list.length) return;
  const at = list.indexOf(target.closest<HTMLElement>(selector(box)) ?? target);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : Math.max(0, Math.min(list.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
  e.preventDefault();
  list[at < 0 && e.key === 'ArrowUp' ? list.length - 1 : at < 0 && e.key === 'ArrowDown' ? 0 : next]?.focus();
}

/**
 * A segmented control or a row of tabs, as on macOS and iOS: the arrows step to
 * the next choice and pick it (←/→ across, ↑/↓ by rows, Home/End to the ends).
 * Groups with keys of their own (the agent picker) handle them first.
 */
function pickKey(e: KeyboardEvent, target: HTMLElement): boolean {
  const radio = target.closest<HTMLElement>('[role="radio"], [role="tab"]');
  const box = radio?.parentElement?.closest<HTMLElement>(radio.getAttribute('role') === 'tab' ? '[role="tablist"]' : '[role="radiogroup"]');
  if (!radio || !box) return false;
  // A tab row also roves up and down as a list (data-rove); across is ours.
  if (box.hasAttribute('data-rove') && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return false;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return false;
  // A single row has nothing above or below: ↑/↓ step back and forward, as a radio group's do.
  const next = radioGridMove(box, radio, e.key) ?? (e.key === 'ArrowDown' || e.key === 'ArrowUp' ? radioGridMove(box, radio, e.key === 'ArrowDown' ? 'ArrowRight' : 'ArrowLeft') : null);
  e.preventDefault();
  if (!next || next === radio) return true;
  next.focus();
  next.click();
  return true;
}

/** The list of the page in view (Inbox, History), if it has one: on top, not under New session. */
export function pageList(): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('.page[data-rove]')].find((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 200));
      return !!top && el.contains(top);
    }) ?? null
  );
}

/**
 * Arrow keys across a grid of buttons (the agent picker): the nearest item in that
 * direction, by where they sit on screen, so it follows however the grid wraps.
 */
export function gridMove(box: HTMLElement, from: HTMLElement, key: string): HTMLElement | null {
  const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[key];
  if (!dir) return null;
  const c = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const a = c(from);
  let best: HTMLElement | null = null;
  let score = Infinity;
  const all = [...box.querySelectorAll<HTMLElement>('button:not([disabled])')].filter((el) => el.getClientRects().length > 0);
  for (const el of all) {
    if (el === from) continue;
    const b = c(el);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const along = dx * dir[0] + dy * dir[1];
    if (along <= 1) continue;
    const across = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]);
    const d = along + across * 2;
    if (d < score) [score, best] = [d, el];
  }
  return best;
}

/**
 * A radio group laid out as a grid: ←/→ step through the choices in reading
 * order and wrap, ↑/↓ move between rows (gridMove), Home/End go to the ends.
 */
export function radioGridMove(box: HTMLElement, from: HTMLElement, key: string): HTMLElement | null {
  const all = [...box.querySelectorAll<HTMLElement>('button:not([disabled])')].filter((el) => el.getClientRects().length > 0);
  if (!all.length) return null;
  const at = all.indexOf(from);
  if (key === 'Home') return all[0];
  if (key === 'End') return all.at(-1)!;
  if (key === 'ArrowLeft' || key === 'ArrowRight') return all[(at + (key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
  return gridMove(box, from, key);
}

/** Focus a page's first item: the keyboard into the main view when no session is open. */
export function focusPage(): boolean {
  const box = pageList();
  const first = box ? items(box)[0] : null;
  first?.focus();
  return !!first;
}

/** Focus the first item of a list once it is drawn (a menu opened from the keyboard). */
export function focusFirst(box: HTMLElement | null) {
  requestAnimationFrame(() => {
    if (box) items(box)[0]?.focus();
  });
}

/**
 * When the focused item of a list goes away (an answered card, a hidden conversation),
 * focus moves to the item that took its place, as in a native list, instead of falling
 * to the page where the next key does nothing. Returns the uninstaller.
 */
export function keepListFocus(): () => void {
  // The last list item focused. Removing a focused element fires no focusout in every
  // browser, so removals are noticed by watching the page change.
  let last: { el: HTMLElement; box: HTMLElement; index: number } | null = null;
  const onIn = (e: FocusEvent) => {
    const el = e.target as HTMLElement;
    const box = el.closest<HTMLElement>('[data-rove]');
    if (!box) return void (last = null);
    // Its place in the list: the item it is, or the nearest one before it (a card's
    // option buttons sit under the card's title, which is the list item).
    const list = items(box);
    let index = -1;
    list.forEach((item, i) => {
      if (item === el || item.contains(el) || item.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) index = i;
    });
    last = { el, box, index };
  };
  const mo = new MutationObserver(() => {
    if (!last || last.el.isConnected) return;
    const { box, index } = last;
    last = null;
    if (!box.isConnected || index < 0) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const list = items(box);
    list[Math.min(index, list.length - 1)]?.focus();
  });
  mo.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('focusin', onIn);
  return () => {
    mo.disconnect();
    document.removeEventListener('focusin', onIn);
  };
}
