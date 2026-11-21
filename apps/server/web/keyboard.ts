// One-shot modifiers for both the touch key row and terminal keyboard input.
const UNSHIFTED = "`1234567890-=[]\\;',./";
const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';

/** Physical-key arrow behavior inside the terminal. `send` writes bytes to the pty.
 *  Session cycling is a UI shortcut (shortcuts.ts), not a pty byte. */
export type ArrowAction = { send: string };
export type ArrowMods = { meta: boolean; alt: boolean; ctrl: boolean; shift: boolean };

/**
 * Cmd+Left/Right seek line ends (Home/End), Option+Left/Right seek words
 * (ESC b/f, like GUI terminals). Everything else stays with xterm — notably
 * Shift selections, Ctrl combinations, and Option+Up/Down (those cycle sessions
 * through the UI shortcut table). Handling these here, with preventDefault at
 * the call site, also keeps the browser from eating them as Back/Forward.
 */
export function terminalArrow(key: string, mod: ArrowMods): ArrowAction | null {
  if (mod.shift || mod.ctrl) return null;
  switch (key) {
    case 'ArrowLeft':
      if (mod.meta) return { send: '\x1b[H' };
      if (mod.alt) return { send: '\x1bb' };
      return null;
    case 'ArrowRight':
      if (mod.meta) return { send: '\x1b[F' };
      if (mod.alt) return { send: '\x1bf' };
      return null;
    default:
      return null;
  }
}

/** Step through sidebar-ordered session keys with wrap-around. */
export function cycleKey(keys: string[], anchor: string | null, dir: -1 | 1): string | null {
  if (!keys.length) return null;
  const i = anchor === null ? -1 : keys.indexOf(anchor);
  if (i < 0) return dir > 0 ? keys[0] : keys[keys.length - 1];
  return keys[(i + dir + keys.length) % keys.length];
}

export function applyModifiers(data: string, ctrl: boolean, alt: boolean, shift = false): string {
  const modifiers = (shift ? 1 : 0) | (alt ? 2 : 0) | (ctrl ? 4 : 0);
  const cursor = data.match(/^\x1b(?:\[|O)([ABCDHF])$/);
  const modifiedCursor = data.match(/^\x1b\[1;(\d+)([ABCDHF])$/);
  if (modifiers && (cursor || modifiedCursor)) {
    const letter = cursor?.[1] ?? modifiedCursor![2];
    // Sticky Alt on the touch key bar matches physical Option: Left/Right move
    // by word. Other modified cursors keep the standard encoding.
    if (alt && !ctrl && !shift && (letter === 'D' || letter === 'C')) return letter === 'D' ? '\x1bb' : '\x1bf';
    const existing = modifiedCursor ? Number(modifiedCursor[1]) - 1 : 0;
    return `\x1b[1;${1 + (existing | modifiers)}${letter}`;
  }
  let out = data;
  if (shift) {
    if (out === '\t') out = '\x1b[Z';
    else if (out === '\r') out = '\n'; // Agent multiline input (Ctrl+J).
    else if (out.length === 1) {
      const i = UNSHIFTED.indexOf(out);
      out = i >= 0 ? SHIFTED[i] : out.toUpperCase();
    }
  }
  if (ctrl && out.length === 1) {
    const c = out.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64);
    else if (out === ' ') out = '\x00';
  }
  if (alt) out = '\x1b' + out;
  return out;
}
