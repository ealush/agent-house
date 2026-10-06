// Appearance theme: 'system' follows the OS, 'dark' / 'light' pin it.
// The resolved value lands on <html data-theme="..."> so every CSS variable
// flips at once; xterm palettes live here too so the terminal follows.
// Pure logic (no React) so node --test can import this directly.

export type ThemeMode = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

export const THEME_KEY = 'ah.theme';

const MODES: ThemeMode[] = ['system', 'dark', 'light'];

/** Unknown / corrupt values fall back to following the OS. */
export function parseThemeMode(v: unknown): ThemeMode {
  return v === 'dark' || v === 'light' || v === 'system' ? v : 'system';
}

export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return systemDark ? 'dark' : 'light';
}

function getDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

export function systemIsDark(): boolean {
  try {
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}

export function currentMode(): ThemeMode {
  try {
    return parseThemeMode(localStorage.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

type Listener = (resolved: ResolvedTheme, mode: ThemeMode) => void;

const listeners = new Set<Listener>();
let cachedMode: ThemeMode = 'system';
let cachedResolved: ResolvedTheme = 'dark';
let initialized = false;

export function getMode(): ThemeMode {
  return cachedMode;
}

export function getResolved(): ResolvedTheme {
  return cachedResolved;
}

/** Paint the resolved theme onto the document (no-op outside a browser). */
export function applyTheme(resolved: ResolvedTheme, mode: ThemeMode): void {
  cachedMode = mode;
  cachedResolved = resolved;
  const doc = getDocument();
  if (doc) {
    doc.documentElement.dataset.theme = resolved;
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'light' ? '#ffffff' : '#0e1014');
  }
  for (const fn of listeners) fn(resolved, mode);
}

/** Persist a mode and apply it immediately. */
export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {}
  applyTheme(resolveTheme(mode, systemIsDark()), mode);
}

export function subscribeTheme(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Read the stored mode, paint it, and keep it fresh: OS changes while in
 * 'system' mode, and stored changes from another tab. Returns a cleanup.
 */
export function initTheme(): () => void {
  const apply = () => {
    const mode = currentMode();
    applyTheme(resolveTheme(mode, systemIsDark()), mode);
  };
  apply();
  if (initialized) return () => {};
  initialized = true;
  let media: MediaQueryList | null = null;
  const onMedia = () => {
    if (currentMode() === 'system') apply();
  };
  try {
    media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', onMedia);
  } catch {
    media = null;
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_KEY) apply();
  };
  try {
    window.addEventListener('storage', onStorage);
  } catch {}
  return () => {
    try {
      media?.removeEventListener('change', onMedia);
    } catch {}
    try {
      window.removeEventListener('storage', onStorage);
    } catch {}
    initialized = false;
  };
}

/** Next mode for a quick toggle: the opposite of what's on screen, pinned. */
export function toggleMode(mode: ThemeMode, resolved: ResolvedTheme): ThemeMode {
  void mode;
  return resolved === 'dark' ? 'light' : 'dark';
}

export const MODES_IN_ORDER = MODES;

// xterm palette. The terminal stays dark in both UI themes (code surfaces
// keep one high-contrast home, like the TUIs inside it expect), so there is
// exactly one palette. The canvas paints its own background; CSS variables
// can't reach it.
export const TERMINAL_THEME: Record<string, string> = {
  background: '#0e1014',
  foreground: '#e8e6e1',
  cursor: '#e8b04a',
  cursorAccent: '#0e1014',
  selectionBackground: '#e8b04a55',
  black: '#1a1d23',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d7dae0',
  brightBlack: '#5c6370',
  brightRed: '#ef7b84',
  brightGreen: '#a9d48a',
  brightYellow: '#f0cd8c',
  brightBlue: '#74bdfa',
  brightMagenta: '#d58ce9',
  brightCyan: '#68c7d3',
  brightWhite: '#ffffff',
};
