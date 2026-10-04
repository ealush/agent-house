// One-shot modifiers for both the touch key row and terminal keyboard input.
const UNSHIFTED = "`1234567890-=[]\\;',./";
const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';

export function applyModifiers(data: string, ctrl: boolean, alt: boolean, shift = false): string {
  const modifiers = (shift ? 1 : 0) | (alt ? 2 : 0) | (ctrl ? 4 : 0);
  const cursor = data.match(/^\x1b(?:\[|O)([ABCDHF])$/);
  const modifiedCursor = data.match(/^\x1b\[1;(\d+)([ABCDHF])$/);
  if (modifiers && (cursor || modifiedCursor)) {
    const existing = modifiedCursor ? Number(modifiedCursor[1]) - 1 : 0;
    return `\x1b[1;${1 + (existing | modifiers)}${cursor?.[1] ?? modifiedCursor![2]}`;
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
