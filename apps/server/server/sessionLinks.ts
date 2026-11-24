// A session's link pasted into a message to an agent ("look at what we did in <link>"):
// the agent can't open it (it's behind a sign-in), and doesn't know ah. Each one on this
// host gets a line after the message saying which session it is and the command that
// prints its conversation (`ah conversation`). Pure: text in, text out.
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Session references in a message:
 * - Full web URL ("https://host/#<uid>", optional "?m=…")
 * - `#` mention ("#<uid>", inserted by `#` session autocomplete)
 * - Bare session UID ("ah-xxxxxxxx" or 8-char hex uid — matched ONLY if `title(uid)` finds a real session)
 */
const LINK = /\bhttps?:\/\/[^\s#<>()]+\/#([\w-]{4,40})(?:\?[^\s<>()]*)?|(?<=^|\s)#([\w-]{4,40})(?=$|[\s.,;:!?)\]}])|(?<=^|\s)(ah-[0-9a-f]{8}|[0-9a-f]{8})(?=$|[\s.,;:!?)\]}])/g;

/**
 * `text` with a line for each session link or `#<uid>` mention in it that names a session here,
 * unless it says how to read it already. `title`: the session's title, or null when it's none of this host's.
 * `command`: how to run ah here ("ah", or the full path when it isn't on PATH).
 */
export function linkHints(text: string, title: (uid: string) => string | null, command: string): string {
  const seen = new Set<string>();
  const hints: string[] = [];
  for (const m of text.matchAll(LINK)) {
    const uid = m[1] ?? m[2] ?? m[3];
    if (!uid || seen.has(uid)) continue;
    const name = title(uid);
    if (name === null) continue;
    seen.add(uid);
    const read = `${command} conversation ${uid}`;
    if (text.includes(read)) continue;
    hints.push(`[ah: ${m[0]} is the ah session "${name}". Print its conversation with: ${read}]`);
  }
  return hints.length ? `${text}\n\n${hints.join('\n')}` : text;
}

/** One of those lines, as a transcript has it back. */
const HINT = /^\[ah: \S+ is the ah session ".*"\. Print its conversation with: .+ conversation [\w-]{4,40}\]$/;

export const isLinkHint = (line: string) => HINT.test(line.trim());

/**
 * A message as it was typed, without the lines `linkHints` put after it: what every list
 * and bubble shows, and what a device matches its sent message by.
 */
export function withoutLinkHints(text: string): string {
  const lines = text.split('\n');
  let end = lines.length;
  while (end > 0 && (isLinkHint(lines[end - 1]) || (!lines[end - 1].trim() && end < lines.length))) end--;
  if (end === lines.length) return text;
  return lines.slice(0, end).join('\n').trimEnd();
}

/** The repository's stable entry point (bin/ah.js at its root). */
const ENTRY = fileURLToPath(new URL('../../../bin/ah.js', import.meta.url));

/** "ah" when it's on PATH, else this checkout's entry point run by this Node. */
export function ahCommand(path = process.env.PATH ?? ''): string {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(dir, 'ah'), constants.X_OK);
      return 'ah';
    } catch {}
  }
  return `${process.execPath} ${ENTRY}`;
}
