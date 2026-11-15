import type { HostApi, Win } from './api.ts';

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

/** A pane at its shell's prompt has the shell as its foreground command (`-zsh` for a login shell). */
const PROMPTS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'mksh', 'tcsh', 'csh', 'nu', 'elvish', 'xonsh', 'pwsh']);

const commandName = (command: string) => command.trim().replace(/^-/, '').split('/').pop() ?? '';

/**
 * The shell it's typed into: one of the session's host's shells in the session's folder,
 * waiting at its prompt, the one used last. One running a server or an editor would take
 * the words as its own input. Undefined: start one.
 */
export function idleShell(w: Win, windows: Win[]): Win | undefined {
  return windows
    .filter((x) => x.host === w.host && x.key !== w.key && !x.agent && x.cwd === w.cwd && PROMPTS.has(commandName(x.command)))
    .reduce<Win | undefined>((best, x) => (!best || x.activity > best.activity ? x : best), undefined);
}

/** Where it runs, as the button says it: the project, and the branch when there is one. */
export const runPlace = (w: Win) => [w.project, w.branch ?? ''].filter(Boolean).join(' · ') || 'its folder';

/**
 * Types the snippet with Enter into that shell, or a new one in the session's folder, and
 * returns the shell's key to show it by (the session's own form: bare here, `host/uid` on a peer).
 */
export async function runInShell(client: Pick<HostApi, 'create' | 'send'>, w: Win, windows: Win[], snippet: string): Promise<string | null> {
  const command = shellCommand(snippet);
  if (!command) return null;
  let uid = idleShell(w, windows)?.uid;
  uid ??= (await client.create({ preset: 'shell', cwd: w.cwd || w.projectPath, session: w.session, label: '', resume: false })).uid;
  await client.send(uid, command, true);
  return w.key === w.uid ? uid : `${w.host}/${uid}`;
}
