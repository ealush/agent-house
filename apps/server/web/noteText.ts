// A note's files (docs/spec/15-scratchpads.md, SCR-7). A note keeps each file it carries as
// its path in ah's upload folder, as a sent message carries it, so handing the note to an
// agent or saving it as a file needs nothing more. Its editor shows each as its token instead
// ("@paste.png"), drawn as a chip, and puts the path back on every change.
import { shellQuote } from './api.ts';
import { findMentions } from './mentions.ts';
import { uploadOf, uploadToken, type PlacedUpload } from './uploads.ts';

// An upload's path standing alone, as words do: what ends a sentence after it isn't part of it.
const UPLOAD = /(?<=^|\s)(?:'([^'\n]*\/ah\/uploads\/[^'/\n]+)'|(\/[^\s'"`<>]*\/ah\/uploads\/[\w.-]+?))(?=[.,;:!?)\]}]*(?:\s|$))/g;

/**
 * The note's text as its editor shows it: each upload's path as "@<token>", and the uploads
 * in the order they're written. `known` (path → token) keeps a chip's name while it's open, so
 * taking out one "paste.png" doesn't rename the next; new ones are added to it. `taken`:
 * tokens already used (uploads still on their way).
 */
export function shownText(markdown: string, known: Map<string, string>, taken: Iterable<string> = []): { text: string; uploads: PlacedUpload[] } {
  const found = [...markdown.matchAll(UPLOAD)].map((m) => ({ at: m.index, length: m[0].length, upload: uploadOf(m[1] ?? m[2]) }));
  if (!found.length) return { text: markdown, uploads: [] };
  const used = new Set(taken);
  const tokens: (string | undefined)[] = found.map(({ upload }) => {
    const kept = known.get(upload.path);
    if (!kept || used.has(kept)) return undefined;
    used.add(kept);
    return kept;
  });
  for (const [i, { upload }] of found.entries()) {
    if (tokens[i]) continue;
    tokens[i] = uploadToken(upload.name, used);
    if (!known.has(upload.path)) known.set(upload.path, tokens[i]!);
  }
  let text = '';
  let at = 0;
  const uploads = found.map((f, i) => {
    text += `${markdown.slice(at, f.at)}@${tokens[i]}`;
    at = f.at + f.length;
    return { ...f.upload, token: tokens[i]! };
  });
  return { text: text + markdown.slice(at), uploads };
}

/**
 * The note's Markdown from its editor's text: each upload's token (the first "@<token>" of
 * each, as a message's) put back as its path. `paths` (token → path): the uploads shown, and
 * any shown before, so a chip typed back after it was broken up is the file again.
 */
export function noteMarkdown(text: string, paths: Map<string, string>): string {
  if (!paths.size) return text;
  const seen = new Set<string>();
  const found = findMentions(text).filter((m) => paths.has(m.path) && !seen.has(m.path) && !!seen.add(m.path));
  let out = text;
  for (const m of found.reverse()) out = out.slice(0, m.start) + shellQuote(paths.get(m.path)!) + out.slice(m.end);
  return out;
}

/** Token → path for `noteMarkdown`: what `known` named before, then what's shown now (which wins). */
export function tokenPaths(known: Map<string, string>, uploads: PlacedUpload[]): Map<string, string> {
  const paths = new Map([...known].map(([path, token]) => [token, path]));
  for (const u of uploads) paths.set(u.token, u.path);
  return paths;
}
