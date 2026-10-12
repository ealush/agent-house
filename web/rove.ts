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
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  const target = e.target as HTMLElement | null;
  if (!target || target.closest('input, textarea, select, [contenteditable="true"], .xterm')) return;
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

/** The list of the page in view (Inbox, History, Sessions), if it has one: on top, not under New session. */
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
