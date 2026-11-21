// An attachment in the message's text: its chip's place ("@<token>"), and its path put
// there when the message goes (web/attachments.tsx has the tiles and the uploads).
import { shellQuote } from './api.ts';
import { findMentions, type Mention } from './mentions.ts';

/** A file on its way into the message. `path` is set once it is on the host; `token` is its
 *  name in the text ("@<token>"), where it has one. */
export type Attachment = { id: number; name: string; image: boolean; src?: string; path?: string; token?: string };

/** Where each attachment's chip is in the text, by attachment. */
export function attachmentChips(files: Attachment[], text: string): Array<Mention & { file: Attachment }> {
  const byToken = new Map(files.filter((f) => f.token).map((f) => [f.token!, f]));
  if (!byToken.size) return [];
  const seen = new Set<string>();
  // The first of each, should the same name be typed again.
  return findMentions(text).flatMap((m) => {
    const file = byToken.get(m.path);
    if (!file || seen.has(m.path)) return [];
    seen.add(m.path);
    return [{ ...m, file }];
  });
}

/** The message as sent: each file's path where its chip is, the rest in front of the text. */
export function withAttachments(files: Attachment[], text: string): string {
  const placed = attachmentChips(files, text);
  let out = text;
  // From the end, so each place is still where it was found.
  for (const m of [...placed].sort((a, b) => b.start - a.start)) out = out.slice(0, m.start) + shellQuote(m.file.path!) + out.slice(m.end);
  const front = files.filter((f) => !placed.some((m) => m.file.id === f.id)).map((f) => shellQuote(f.path!));
  return [...front, out.trim() ? out : ''].filter(Boolean).join(' ');
}

