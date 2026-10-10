// The desktop's Omarchy theme, so ah can wear it on every device: the applied
// theme lives in ~/.local/state/omarchy/current/ (theme.name, theme/colors.toml,
// a flat file of `key = "#rrggbb"` plus `mode = "dark" | "light"`). Read-only;
// absent on machines without Omarchy.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = () => process.env.OMARCHY_STATE_DIR ?? join(homedir(), '.local', 'state', 'omarchy', 'current');

export type OmarchyTheme = { name: string; mode: 'dark' | 'light'; colors: Record<string, string>; font: string | null };

let fontCache: { at: number; font: string | null } | null = null;

/** The desktop's monospace font, as `omarchy font current` reads it (fontconfig). Cached 30s. */
export function omarchyFont(): string | null {
  if (fontCache && Date.now() - fontCache.at < 30_000) return fontCache.font;
  let font: string | null = null;
  try {
    font = execFileSync('fc-match', ['monospace', '-f', '%{family}'], { encoding: 'utf8', timeout: 1500 }).split(',')[0].trim() || null;
  } catch {}
  fontCache = { at: Date.now(), font };
  return font;
}

/** `key = "value"` lines; comments, tables and anything else are ignored. */
export function parseColors(text: string): { mode: 'dark' | 'light'; colors: Record<string, string> } {
  const colors: Record<string, string> = {};
  let mode: 'dark' | 'light' = 'dark';
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([a-z_]+)\s*=\s*"([^"]*)"\s*(#.*)?$/);
    if (!m) continue;
    if (m[1] === 'mode') mode = m[2] === 'light' ? 'light' : 'dark';
    else if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(m[2])) colors[m[1]] = m[2].toLowerCase();
  }
  return { mode, colors };
}

/** Name and change time of the applied theme (cheap: one stat), or null without Omarchy. */
export function omarchyStamp(): { name: string; at: number; font: string | null } | null {
  try {
    const at = Math.floor(statSync(join(dir(), 'theme', 'colors.toml')).mtimeMs);
    let name = '';
    try {
      name = readFileSync(join(dir(), 'theme.name'), 'utf8').trim();
    } catch {}
    return { name, at, font: omarchyFont() };
  } catch {
    return null;
  }
}

export function omarchyTheme(): OmarchyTheme | null {
  try {
    const { mode, colors } = parseColors(readFileSync(join(dir(), 'theme', 'colors.toml'), 'utf8'));
    if (!colors.background || !colors.foreground || !colors.accent) return null;
    return { name: omarchyStamp()?.name ?? '', mode, colors, font: omarchyFont() };
  } catch {
    return null;
  }
}
