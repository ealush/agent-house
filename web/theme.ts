// Appearance theme: 'system' follows the OS, 'dark' / 'light' pin it.
// The resolved value lands on <html data-theme="..."> so every CSS variable
// flips at once; xterm palettes live here too so the terminal follows.
// Pure logic (no React) so node --test can import this directly.

export type ThemeMode = 'system' | 'dark' | 'light' | 'omarchy';
export type ResolvedTheme = 'dark' | 'light';

export const THEME_KEY = 'ah.theme';

const MODES: ThemeMode[] = ['system', 'dark', 'light', 'omarchy'];

/** Unknown / corrupt values fall back to following the OS. */
export function parseThemeMode(v: unknown): ThemeMode {
  return v === 'dark' || v === 'light' || v === 'system' || v === 'omarchy' ? v : 'system';
}

export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === 'omarchy') return omarchy?.mode ?? (systemDark ? 'dark' : 'light');
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

// ---------- Omarchy: wear the desktop's theme (server/omarchy.ts reads it)

export type OmarchyPalette = { name: string; mode: 'dark' | 'light'; colors: Record<string, string>; font?: string | null };

/** ah's monospace stack; the desktop's font goes first when following Omarchy. */
export const MONO = "'JetBrainsMono Nerd Font', 'JetBrains Mono Variable', 'SF Mono', Menlo, ui-monospace, monospace";

/** The terminal's font right now (devices without the desktop's font fall back down the stack). */
export function terminalFont(): string {
  const f = cachedMode === 'omarchy' ? omarchy?.font : null;
  return f ? `'${f.replace(/'/g, '')}', ${MONO}` : MONO;
}

const OMARCHY_KEY = 'ah.omarchy.palette';
let omarchy: OmarchyPalette | null = (() => {
  try {
    return JSON.parse(localStorage.getItem(OMARCHY_KEY) ?? 'null');
  } catch {
    return null;
  }
})();

function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** ah's color tokens from an Omarchy colors.toml. */
export function omarchyVars(p: OmarchyPalette): Record<string, string> {
  const c = p.colors;
  const pick = (...keys: string[]) => keys.map((k) => c[k]).find(Boolean) ?? c.foreground;
  return {
    '--bg': c.background,
    '--surface': pick('dark_background', 'background'),
    '--raised': pick('lighter_background', 'selection'),
    '--sunken': pick('darker_background', 'dark_background'),
    '--line': alpha(c.foreground, 0.1),
    '--line-2': alpha(c.foreground, 0.2),
    '--text': pick('bright_foreground', 'foreground'),
    '--text-2': c.foreground,
    '--muted': pick('dark_foreground', 'muted'),
    '--faint': pick('muted', 'dark_foreground'),
    '--brand': c.accent,
    '--accent': c.accent,
    '--accent-strong': c.accent,
    '--accent-hover': c.accent,
    '--accent-ink': c.background,
    '--accent-bg': alpha(c.accent, 0.12),
    '--accent-line': alpha(c.accent, 0.4),
    '--cyan': pick('cyan', 'blue'),
    '--run': pick('cyan', 'blue'),
    '--done': pick('green'),
    '--danger': pick('red'),
    '--danger-ink': c.background,
    '--amber': pick('yellow', 'accent'),
    ...(p.font ? { '--mono': `'${p.font.replace(/'/g, '')}', ${MONO}` } : {}),
  };
}

/** The terminal palette the way Omarchy maps colors.toml for its own terminals. */
export function omarchyTerminal(p: OmarchyPalette): Record<string, string> {
  const c = p.colors;
  const or = (k: string, f: string) => c[k] ?? c[f];
  return {
    background: c.background,
    foreground: c.foreground,
    cursor: or('bright_foreground', 'foreground'),
    cursorAccent: c.background,
    selectionBackground: or('selection', 'lighter_background'),
    black: c.background,
    red: or('red', 'foreground'),
    green: or('green', 'foreground'),
    yellow: or('yellow', 'foreground'),
    blue: or('blue', 'foreground'),
    magenta: or('magenta', 'foreground'),
    cyan: or('cyan', 'foreground'),
    white: c.foreground,
    brightBlack: or('muted', 'dark_foreground'),
    brightRed: or('bright_red', 'red'),
    brightGreen: or('bright_green', 'green'),
    brightYellow: or('bright_yellow', 'yellow'),
    brightBlue: or('bright_blue', 'blue'),
    brightMagenta: or('bright_magenta', 'magenta'),
    brightCyan: or('bright_cyan', 'cyan'),
    brightWhite: or('bright_foreground', 'foreground'),
  };
}

/** A fresh palette from the host; repaints when Omarchy mode is on. */
export function setOmarchyPalette(p: OmarchyPalette | null): void {
  omarchy = p;
  try {
    if (p) localStorage.setItem(OMARCHY_KEY, JSON.stringify(p));
    else localStorage.removeItem(OMARCHY_KEY);
  } catch {}
  if (cachedMode === 'omarchy') applyTheme(resolveTheme('omarchy', systemIsDark()), 'omarchy');
}

export function getOmarchyPalette(): OmarchyPalette | null {
  return omarchy;
}

/** xterm's palette right now: Omarchy's while following it, else ah's own. */
export function terminalTheme(): Record<string, string> {
  return cachedMode === 'omarchy' && omarchy ? omarchyTerminal(omarchy) : TERMINAL_THEME;
}

let painted: string[] = [];

/** Paint the resolved theme onto the document (no-op outside a browser). */
export function applyTheme(resolved: ResolvedTheme, mode: ThemeMode): void {
  cachedMode = mode;
  cachedResolved = resolved;
  const doc = getDocument();
  if (doc) {
    const root = doc.documentElement;
    root.dataset.theme = resolved;
    for (const k of painted) root.style.removeProperty(k);
    painted = [];
    const vars = mode === 'omarchy' && omarchy ? omarchyVars(omarchy) : null;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) if (v) root.style.setProperty(k, v);
      painted = Object.keys(vars);
    }
    // The terminal's gutter matches its canvas, whichever palette it has.
    root.style.setProperty('--term-bg', terminalTheme().background);
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', vars ? vars['--bg'] : resolved === 'light' ? '#ffffff' : '#0e1014');
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
