import type { AttachedTerminal, HostApi, Win } from './api.ts';

/**
 * Run in Terminal on a code block in the agent's reply: what the snippet types, and which
 * shell takes it. ah-native's `ShellRun` follows the same rules.
 */

const LANGUAGES = new Set(['sh', 'bash', 'zsh', 'fish', 'ksh', 'nu', 'shell', 'console', 'terminal', 'shellsession', 'shell-session']);

/** A block in no language, or in a shell's, is something to run; TypeScript or JSON isn't. */
export function runsLanguage(language: string | null | undefined): boolean {
  const l = (language ?? '').trim().toLowerCase();
  return !l || LANGUAGES.has(l);
}

/**
 * What the shell is given: the words, less the marks that aren't part of the command.
 * A `$ ` before every line is a prompt, copied with them. A `! ` before the first is
 * Claude Code's (its box runs the rest in a shell); typed to a shell it's `!`, which flips
 * the exit status, so `! cd x && make` never ran make.
 */
export function shellCommand(snippet: string): string {
  const text = snippet.trim();
  const lines = text.split('\n');
  const said = lines.filter((l) => l.trim());
  if (said.length && said.every((l) => l.startsWith('$ '))) return lines.map((l) => (l.startsWith('$ ') ? l.slice(2) : l)).join('\n');
  if (text.startsWith('! ')) return text.slice(2).trim();
  return text;
}

/** Where it runs, as the button says it: the project, and the branch when there is one. */
export const runPlace = (w: Win) => [w.project, w.branch ?? ''].filter(Boolean).join(' · ') || 'its folder';

/**
 * The host owns the attachment and checks that its shell is ready. It never chooses a
 * standalone shell by directory or silently starts another when this one is busy.
 */
export async function runInShell(client: Pick<HostApi, 'openTerminal'>, w: Win, snippet: string): Promise<AttachedTerminal | null> {
  const command = shellCommand(snippet);
  if (!command) return null;
  return (await client.openTerminal(w.uid, command)).terminal;
}
