import { useSyncExternalStore } from 'react';

// iPadOS 26 draws a window's buttons (close, minimize, tile) over its top-left corner.
// A native app in a window gets a 32pt strip at the top for them; a home-screen web app
// gets none (safe-area-inset-top reads 0 and WebKit has no titlebar-area-*), so ah's
// corner — the brand, the sidebar button, a page's title, the back button — sat under
// them. ah takes the same strip itself when it is a home-screen app in a window (or
// when Settings → Appearance says always): <html data-window-controls>, and the
// --safe-top every top edge uses (styles.css) is at least 32px.
//
// Full screen has no buttons there (the status bar takes the top, and reports it).

export type WindowControlsMode = 'auto' | 'on' | 'off';

const KEY = 'ah.windowControls';

export type WindowInfo = { standalone: boolean; ipad: boolean; innerW: number; innerH: number; screenW: number; screenH: number };

/**
 * A home-screen app on an iPad in a window: narrower than the screen in its orientation,
 * or clearly shorter. Not by a little: iOS home-screen apps can come up ~60pt short of
 * the screen in full screen (viewport.ts's shim). The screen's sides are compared either
 * way round, since iPadOS reports them in portrait.
 */
export function inWindow(o: WindowInfo): boolean {
  if (!o.standalone || !o.ipad || !o.screenW || !o.screenH) return false;
  const long = Math.max(o.screenW, o.screenH);
  const short = Math.min(o.screenW, o.screenH);
  const landscape = o.innerW > o.innerH;
  const fullW = landscape ? long : short;
  const fullH = landscape ? short : long;
  return o.innerW < fullW - 2 || o.innerH < fullH - 100;
}

export function parseMode(v: unknown): WindowControlsMode {
  return v === 'on' || v === 'off' ? v : 'auto';
}

export function windowInfo(win: Window): WindowInfo {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  const ua = nav?.userAgent ?? '';
  return {
    standalone: (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches) || nav?.standalone === true,
    // iPadOS Safari says it is a Mac; a Mac has no touch points.
    ipad: /iPad/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1),
    innerW: win.innerWidth,
    innerH: win.innerHeight,
    screenW: win.screen?.width ?? 0,
    screenH: win.screen?.height ?? 0,
  };
}

let mode: WindowControlsMode = 'auto';
try {
  mode = parseMode(localStorage.getItem(KEY));
} catch {}
const subs = new Set<() => void>();

function apply() {
  if (typeof window === 'undefined') return;
  const on = mode === 'on' || (mode === 'auto' && inWindow(windowInfo(window)));
  const root = document.documentElement;
  if (on === root.hasAttribute('data-window-controls')) return;
  if (on) root.dataset.windowControls = '';
  else delete root.dataset.windowControls;
}

let installed = false;

export function installWindowControls() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  apply();
  // A window resized, tiled, or made full screen.
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
}

export function setWindowControls(next: WindowControlsMode) {
  mode = next;
  try {
    if (next === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {}
  apply();
  for (const f of subs) f();
}

/** The setting, and whether this device could have window buttons at all (an iPad). */
export function useWindowControls(): { mode: WindowControlsMode; ipad: boolean; on: boolean } {
  const m = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => mode,
    () => 'auto' as const,
  );
  const ipad = typeof window !== 'undefined' && windowInfo(window).ipad;
  const on = typeof document !== 'undefined' && document.documentElement.hasAttribute('data-window-controls');
  return { mode: m, ipad, on };
}
