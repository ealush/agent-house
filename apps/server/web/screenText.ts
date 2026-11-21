// Terminal prompt text, made readable outside the terminal: the inbox card,
// the GUI's ask panel. An agent's TUI lays its prompts out for an 80-column
// window, so its text arrives hard-wrapped and framed by rules.

/** The prompt's own question ("Do you want to make this edit to calc.py?"), when a line of the screen text ends with one. */
export function questionLine(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.findLast((l) => l.endsWith('?')) ?? null;
}

/** Screen text without the TUI's rules (──, ╌╌, ....), which only frame things in a terminal, and with its wrapping undone. */
export function cleanScreen(text: string, drop?: string | null): string {
  const lines = text.split('\n').filter((l) => !/^[\s─━╌╍┄┅┈┉╴╶\-–—_=·•.…⎯]+$/.test(l) && (!drop || l.trim() !== drop));
  return unwrap(lines).join('\n').replace(/^\n+|\n+$/g, '');
}

/**
 * Join the lines the TUI broke only because the window was narrow. A line is a
 * wrapped one when it runs to (nearly) the block's full width and the next line
 * carries on in lowercase; anything shorter, or followed by a capital, a digit,
 * a symbol or indentation, is a line the agent meant. A break inside a token
 * longer than the window (a path) joins without a space.
 */
export function unwrap(lines: string[]): string[] {
  const width = Math.max(0, ...lines.map((l) => l.trimEnd().length));
  if (width < 40) return lines.map((l) => l.trim());
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const prev = lines[i - 1];
    const carries = i > 0 && prev.trimEnd().length >= width - 12 && /^\s?[a-z]/.test(lines[i]) && out.length > 0;
    if (!carries) {
      out.push(line);
      continue;
    }
    const last = out[out.length - 1];
    const token = last.slice(last.lastIndexOf(' ') + 1);
    out[out.length - 1] = last + (!last.includes(' ') || token.length > 24 ? '' : ' ') + line;
  }
  return out;
}
