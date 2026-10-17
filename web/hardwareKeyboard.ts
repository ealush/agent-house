import { useSyncExternalStore } from 'react';

// A touch device with a hardware keyboard (an iPad on a Magic Keyboard) is a keyboard
// device: it shows key hints and needs no on-screen key bar. A browser can't ask whether
// a keyboard is attached, so ah notices one: a key the on-screen keyboard can't send
// (Escape, an arrow, Ctrl, ⌘ or Option) means there is one; the on-screen keyboard
// rising over a text field means there isn't (with a hardware keyboard iPadOS shows
// only a short bar). Remembered on this device. Sets <html data-hw-keyboard> (data-keyboard is viewport.ts's on-screen one).

const KEY = 'ah.keyboard';
const ONLY_HARDWARE = new Set(['Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Control', 'Meta', 'Alt']);
/** How much an on-screen keyboard takes off the visible height; iPadOS's bar over a hardware one is ~55px. */
const SOFT = 180;

const touchDevice = () =>
  typeof matchMedia === 'function' && (matchMedia('(hover: none) and (pointer: coarse)').matches || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1 && !matchMedia('(pointer: fine)').matches));

let hw = false;
try {
  hw = localStorage.getItem(KEY) === 'hw';
} catch {}
const subs = new Set<() => void>();

function set(next: boolean) {
  if (next === hw) return;
  hw = next;
  try {
    if (next) localStorage.setItem(KEY, 'hw');
    else localStorage.removeItem(KEY);
  } catch {}
  apply();
  for (const f of subs) f();
}

function apply() {
  if (typeof document === 'undefined') return;
  if (hw && touchDevice()) document.documentElement.dataset.hwKeyboard = '';
  else delete document.documentElement.dataset.hwKeyboard;
}

let installed = false;

export function installHardwareKeyboard() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  apply();
  if (!touchDevice()) return;
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.isTrusted && (ONLY_HARDWARE.has(e.key) || e.ctrlKey || e.metaKey || e.altKey)) set(true);
    },
    true,
  );
  const vv = window.visualViewport;
  vv?.addEventListener('resize', () => {
    const el = document.activeElement;
    const typing = !!el && (el.matches('input, textarea, [contenteditable]') || !!el.closest('.xterm'));
    if (typing && window.innerHeight - vv.height > SOFT) set(false);
  });
}

/** Typing goes to a keyboard, not an on-screen one: a desktop, or a touch device with a hardware keyboard. */
export function keyboardFirst(): boolean {
  return !touchDevice() || hw;
}

/** A hardware keyboard on a touch device (always false on a desktop, which has one anyway). */
export function useHardwareKeyboard(): boolean {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => hw && touchDevice(),
    () => false,
  );
}
