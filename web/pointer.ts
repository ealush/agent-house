// An iPad is touched and pointed at: a finger, then the Magic Keyboard's trackpad, a
// mouse, or the Pencil hovering. Hover styles are for the pointer, as iPadOS's own
// highlights are. A finger's tap also sets :hover in Safari, and it stayed — a button
// lit after you had left it, and a row whose hover shows more (···) took a first tap
// to show it. So <html data-touch> is set while the last pointer was a finger, and
// every :hover rule in the stylesheets is scoped :where(:root:not([data-touch])) …,
// which adds no specificity (test/hoverScope.test.ts holds them to it). A desktop
// never sets it.

let installed = false;

export function installPointer() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const root = document.documentElement;
  const touchDevice = navigator.maxTouchPoints > 0 || (typeof matchMedia === 'function' && matchMedia('(any-pointer: coarse)').matches);
  if (!touchDevice) return;
  if (typeof matchMedia === 'function' && matchMedia('(hover: none)').matches) root.dataset.touch = '';
  // pointerover comes before the hover it would cause, so the finger's tap never lights it.
  const seen = (e: PointerEvent) => {
    const finger = e.pointerType === 'touch';
    if (finger === root.hasAttribute('data-touch')) return;
    if (finger) root.dataset.touch = '';
    else delete root.dataset.touch;
  };
  for (const t of ['pointerover', 'pointerdown', 'pointermove'] as const) window.addEventListener(t, seen, { capture: true, passive: true });
}
