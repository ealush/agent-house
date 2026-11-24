// Image paths in a message: Claude Code swaps each one it's pasted for "[Image #N]" and
// attaches the picture. Pure functions; tmux.ts pastes, queue.ts reads the transcript.

/** An image file's path, which Claude Code swaps for "[Image #1]" as it takes the prompt. */
export const IMAGE_PATH = /(?:^|\s)(?:~|\.{0,2})\/\S+\.(?:png|jpe?g|gif|webp|heic|heif|bmp|tiff?)(?=\s|$)/gi;

/** A piece of a message to paste on its own: words, or a run of image paths (`images` of them). */
export type PastePiece = { text: string; images: number };

/**
 * A message cut where its image paths are, in order: words, then a run of paths, then
 * words… Claude Code reads a paste that holds paths and words together as pictures, and
 * then loses the words (multi-line ones and all) and pictures after the first, so each run
 * of paths goes in as a paste of its own, in its place. Null when there's nothing to cut:
 * no path, or nothing but paths (a paste of paths alone works as it is).
 */
export function imagePieces(text: string): PastePiece[] | null {
  const pieces: PastePiece[] = [];
  let at = 0;
  for (const m of text.matchAll(IMAGE_PATH)) {
    const start = m.index + (m[0].length - m[0].trimStart().length);
    const end = m.index + m[0].length;
    const between = text.slice(at, start);
    const last = pieces.at(-1);
    // Paths with only spaces between them are one run.
    if (last?.images && !between.trim()) {
      last.text += between + text.slice(start, end);
      last.images++;
    } else {
      if (between.trim()) pieces.push({ text: between, images: 0 });
      pieces.push({ text: text.slice(start, end), images: 1 });
    }
    at = end;
  }
  if (text.slice(at).trim()) pieces.push({ text: text.slice(at), images: 0 });
  return pieces.some((p) => p.images) && pieces.some((p) => !p.images) ? pieces : null;
}

/**
 * Whether what an agent's input box shows (`box`, as pendingInput reads it) is the message
 * ah typed as `sent`: the box's words found in it in their order, the box's "[Image #1]"
 * and "[Pasted text #1 …]" standing for the paths and pastes it took in.
 */
export function boxHolds(box: string, sent: string): boolean {
  const PLACEHOLDER = /\[(?:Image|Pasted text) #\d+[^\]]*\]/;
  const words = (s: string) => s.replace(IMAGE_PATH, ' ').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const parts = box.split(new RegExp(PLACEHOLDER, 'g')).map(words).filter(Boolean);
  if (!parts.length) return PLACEHOLDER.test(box);
  const all = words(sent);
  let at = 0;
  for (const part of parts) {
    const found = all.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return true;
}
