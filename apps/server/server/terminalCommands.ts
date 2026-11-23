// A companion shell's commands, as they were run: the line each one was typed on, kept
// when its Return reaches the shell at its prompt (from any viewer, or a snippet ah ran),
// so the last command and what it printed can be read back out of tmux's scrollback and
// handed to the chat. tmux keeps the text; this only remembers where commands began, on
// disk too: the shell outlives ah, and a command that restarts ah (a deploy) is still the
// last one once it's back.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { shellPromptCommand } from './sessions.ts';
import { tmux } from './tmux.ts';

/** The line a command was typed on, prompt and all, as tmux joins it (`-J`), and how many lines it took. */
type Mark = { line: string; lines: number };

const KEPT = 20;
const SCROLLBACK = 5000;
const MAX_LINES = 400;
const MAX_CHARS = 60_000;

/** Where the marks are kept between runs (beside hidden.json). */
const marksFile = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'terminal-commands.json');

/** windowId → its commands' lines, newest last; read from disk the first time it's asked. */
let loaded: Map<string, Mark[]> | null = null;
function marks(): Map<string, Mark[]> {
  if (loaded) return loaded;
  loaded = new Map();
  try {
    const file = marksFile();
    if (existsSync(file)) {
      for (const [id, kept] of Object.entries(JSON.parse(readFileSync(file, 'utf8')) as Record<string, Mark[]>)) {
        if (Array.isArray(kept)) loaded.set(id, kept.filter((m) => typeof m?.line === 'string').map((m) => ({ line: m.line, lines: Math.max(1, Number(m.lines) || 1) })));
      }
    }
  } catch {
    // Unreadable: start over; the prompt's own line still finds the last command.
  }
  return loaded;
}

/** One write at a time, the newest marks last; a failed write only costs memory across a restart. */
let saving: Promise<void> = Promise.resolve();
function save(): void {
  const body = JSON.stringify(Object.fromEntries(marks()));
  saving = saving.then(async () => {
    try {
      await mkdir(dirname(marksFile()), { recursive: true });
      await writeFile(marksFile(), body);
    } catch {}
  });
}

export type LastCommand = {
  /** What was typed, less the prompt when it can be told apart. */
  command: string;
  /** The line it was typed on, as the terminal shows it (the prompt included). */
  line: string;
  /** What it printed, up to the next prompt or, while it runs, so far. */
  output: string;
  /** Still running: the output is what it printed so far. */
  running: boolean;
  /** Longer than was kept: these are its last lines. */
  truncated: boolean;
};

/** Where the window's cursor is, and whether a shell has its prompt there (not a program, copy mode or a full-screen app). */
async function cursor(windowId: string): Promise<{ y: number; width: number; atPrompt: boolean; path: string }> {
  const [y, width, alternate, mode, command, path] = (await tmux('display-message', '-p', '-t', windowId, '#{cursor_y}\t#{pane_width}\t#{alternate_on}\t#{pane_in_mode}\t#{pane_current_command}\t#{pane_current_path}')).trim().split('\t');
  return { y: Number(y) || 0, width: Number(width) || 0, atPrompt: alternate !== '1' && mode !== '1' && shellPromptCommand(command ?? ''), path: path ?? '' };
}

/**
 * Where a command's line ended in the row's last column: tmux marked that row wrapped, so
 * its joined line goes on with the command's first line of output. Newest first, as
 * `lastIndexOf`; -1 when the line doesn't fill whole rows.
 */
function gluedAt(lines: string[], line: string, from: number, width: number): number {
  if (width <= 0 || [...line].length % width !== 0) return -1;
  for (let i = from; i >= 0; i--) if (lines[i].length > line.length && lines[i].startsWith(line)) return i;
  return -1;
}

/** The window's lines as tmux joins them, from `from` (negative: in its history) to the cursor's. */
async function linesTo(windowId: string, from: number, y: number): Promise<string[]> {
  const text = await tmux('capture-pane', '-p', '-J', '-t', windowId, '-S', String(from), '-E', String(y));
  const lines = text.replace(/\n$/, '').split('\n').map((l) => l.trimEnd());
  return lines;
}

/**
 * Notes the command about to run: called just before a Return reaches a companion shell.
 * At its prompt the cursor's line is the command as typed; anywhere else (a program
 * reading input, vim, a REPL) the Return isn't a shell command and nothing is kept.
 * `lines`: how many lines the command takes (a pasted snippet's), the cursor on its last.
 */
export async function markCommand(windowId: string, lines = 1): Promise<void> {
  try {
    const at = await cursor(windowId);
    if (!at.atPrompt) return;
    const line = (await linesTo(windowId, at.y - 30, at.y)).pop() ?? '';
    if (!line.trim()) return;
    const kept = marks().get(windowId) ?? [];
    kept.push({ line, lines: Math.max(1, lines) });
    marks().set(windowId, kept.slice(-KEPT));
    save();
  } catch {
    // A window that went away, or tmux busy: this command just isn't remembered.
  }
}

/** The window's visible screen, as tmux joins its lines, less the blank rows under the last. */
export async function screenText(windowId: string): Promise<string> {
  const text = await tmux('capture-pane', '-p', '-J', '-t', windowId);
  return text.split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n+$/, '');
}

export function forgetCommands(windowId: string): void {
  if (marks().delete(windowId)) save();
}

/** The prompt's line read as `first word … final symbol`, as `shellDetail` matches a prompt that changed (a new git state, a clock). */
function samePrompt(line: string, prompt: string): boolean {
  const a = line.trim().split(/\s+/);
  const b = prompt.trim().split(/\s+/);
  return a.length > 0 && a[0] === b[0] && a[a.length - 1] === b[b.length - 1];
}

/**
 * What was typed on a command's line, less the prompt: the current prompt's text, or what
 * follows its final symbol when about as many words come before it (the folder or the git
 * state in it changed since: "ah-native main ❯ cd ~/code/ah" under "ah main ? ❯").
 */
function typedOn(line: string, prompt: string | null): string {
  if (prompt) {
    const p = prompt.trimEnd();
    if (p && line.startsWith(p)) return line.slice(p.length).trim();
    const words = p.split(/\s+/);
    const symbol = words[words.length - 1];
    if (symbol && words.length > 1) {
      const at = line.indexOf(` ${symbol} `);
      const before = at > 0 ? line.slice(0, at).trim().split(/\s+/).length : -1;
      if (before > 0 && Math.abs(before - (words.length - 1)) <= 2) return line.slice(at + symbol.length + 2).trim();
    }
  }
  return line.trim();
}

/**
 * The prompt two command lines share, up to the space after its final symbol ("$ ", "❯ ",
 * "% "): while a command runs there's no fresh prompt to read it from.
 */
export function sharedPrompt(line: string, other: string): string | null {
  let n = 0;
  while (n < line.length && n < other.length && line[n] === other[n]) n++;
  const cut = line.slice(0, n).search(/[^\p{L}\p{N}\s]\s+(?=\S*$)/u);
  if (cut < 0) return null;
  const prompt = line.slice(0, n).slice(0, cut + 1);
  return prompt.trim() ? prompt : null;
}

/**
 * The newest command run in the window and its output. From the commands ah saw run
 * (newest first, skipping a bare Return at an empty prompt, kept across restarts); without
 * any (typed while ah wasn't watching), at the prompt, the last earlier line that starts
 * with the same prompt.
 */
export async function lastCommand(windowId: string): Promise<LastCommand | null> {
  const at = await cursor(windowId);
  const lines = await linesTo(windowId, -SCROLLBACK, at.y);
  // At the prompt the cursor's line is the next command's, not output; while a command
  // runs, everything to the cursor is what it has printed.
  const prompt = at.atPrompt ? lines[lines.length - 1] : null;
  let end = at.atPrompt ? lines.length - 1 : lines.length;
  let found: { index: number; lines: number } | null = null;
  let before = end;
  for (const mark of [...(marks().get(windowId) ?? [])].reverse()) {
    const index = Math.max(lines.lastIndexOf(mark.line, before - 1), gluedAt(lines, mark.line, before - 1, at.width));
    if (index < 0) break; // scrolled out of the history, or cleared: older ones are too
    if (lines[index] !== mark.line) {
      // Split the command from the output tmux joined onto its line.
      lines.splice(index, 1, mark.line, lines[index].slice(mark.line.length));
      end++;
    }
    // Nothing typed and nothing printed: the next line is the next prompt.
    const bare = prompt !== null && before === index + 1 && typedOn(mark.line, prompt) === '';
    if (!bare) {
      found = { index, lines: mark.lines };
      break;
    }
    before = index;
  }
  if (!found && prompt?.trim()) {
    for (let i = end - 1; i >= 0; i--) {
      const line = lines[i];
      if (line !== prompt && (line.startsWith(`${prompt.trimEnd()} `) || (prompt.includes(' ') && samePrompt(line, prompt) && line.length > prompt.length))) {
        if (typedOn(line, prompt)) found = { index: i, lines: 1 };
        break;
      }
    }
  }
  if (!found) return null;
  const first = Math.max(0, found.index - found.lines + 1);
  const typed = lines.slice(first, found.index + 1);
  let out = lines.slice(found.index + 1, end);
  // A prompt of two lines (a status line naming the folder, then the symbol): its first
  // line is above the next prompt's too, and isn't output. Output that only happens to end
  // as the line above the command did (the same command run twice) names no folder.
  const folder = at.path.split('/').filter(Boolean).pop() ?? '~';
  const status = (line: string) => line.includes(folder) || /(^|\s)~/.test(line);
  if (prompt && out.length && first > 0 && status(lines[first - 1]) && (out[out.length - 1] === lines[first - 1] || samePrompt(out[out.length - 1], lines[first - 1]))) out.pop();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  let truncated = false;
  if (out.length > MAX_LINES) {
    out = out.slice(-MAX_LINES);
    truncated = true;
  }
  let output = out.join('\n');
  if (output.length > MAX_CHARS) {
    output = output.slice(-MAX_CHARS);
    truncated = true;
  }
  // The shortest prompt shared with another command's line: two commands that start
  // alike ("git commit …") share more than the prompt, and the prompt is in every one.
  const shared = (marks().get(windowId) ?? []).filter((m) => m.line !== typed[0]).map((m) => sharedPrompt(typed[0], m.line)).filter((p): p is string => p !== null);
  const known = prompt ?? shared.sort((a, b) => a.length - b.length)[0] ?? null;
  const command = [typedOn(typed[0], known), ...typed.slice(1)].join('\n').trim();
  return { command, line: typed.join('\n'), output, running: !at.atPrompt, truncated };
}
