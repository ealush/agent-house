// A file attached from the composer reaches the agent as its path in ah's upload
// folder, shell-quoted when it needs it. Wherever ah shows that message back to you
// (the feed, the queue tray, the composer on Edit) it reads as the attachment instead.

const UPLOAD = /(?<=^|\s)(?:'([^']*\/ah\/uploads\/[^'/]+)'|(\/\S*\/ah\/uploads\/[^\s/]+))(?=\s|$)/g;
const IMAGE = /\.(?:png|jpe?g|gif|webp|avif)$/i;

export type Upload = { path: string; name: string; image: boolean };

/** An upload by its path on the host. Saved as "<timestamp>-<name>": named the name you gave it. */
export function uploadOf(path: string): Upload {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/^\d{4}-\d\d-\d\dT[\d-]+Z-/, '');
  return { path, name, image: IMAGE.test(path) };
}

/** The uploads a message carries, and its text without them. */
export function splitUploads(text: string): { uploads: Upload[]; rest: string } {
  const uploads = [...text.matchAll(UPLOAD)].map((m) => uploadOf(m[1] ?? m[2]));
  return { uploads, rest: uploads.length ? text.replace(UPLOAD, '').replace(/[ \t]{2,}/g, ' ').trim() : text };
}

/** One line for a message: "2 images · what is in these?". */
export function uploadSummary(text: string): string {
  const { uploads, rest } = splitUploads(text);
  if (!uploads.length) return text;
  const images = uploads.filter((u) => u.image).length;
  const files = uploads.length - images;
  const count = (n: number, one: string) => (n ? `${n} ${one}${n === 1 ? '' : 's'}` : '');
  const label = [count(images, 'image'), count(files, 'file')].filter(Boolean).join(', ');
  return rest ? `${label} · ${rest}` : label;
}

/**
 * The name an attachment goes by in the text, "paste.png" for "@paste.png": its file's name,
 * without what would end a mention (spaces, quotes), and numbered when `taken` has it.
 */
export function uploadToken(name: string, taken: Set<string>): string {
  const clean = name.replace(/[\s@`'"<>]+/g, '-').replace(/^-+|-+$/g, '') || 'file';
  const dot = clean.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ''];
  let token = clean;
  for (let n = 2; taken.has(token); n++) token = `${base}-${n}${ext}`;
  taken.add(token);
  return token;
}

export type PlacedUpload = Upload & { token: string };

/**
 * The uploads a message carries, each where it is in the text: its path there replaced by its
 * token ("@paste.png"), which the composer and the feed draw as a chip in that place. `taken`:
 * tokens already in use (the box's other attachments).
 */
export function placeUploads(text: string, taken = new Set<string>()): { uploads: PlacedUpload[]; text: string } {
  const uploads: PlacedUpload[] = [];
  const placed = text.replace(UPLOAD, (_all, quoted?: string, bare?: string) => {
    const u = uploadOf(quoted ?? bare!);
    const token = uploadToken(u.name, taken);
    uploads.push({ ...u, token });
    return `@${token}`;
  });
  return { uploads, text: uploads.length ? placed : text };
}

/**
 * "[Image #3]": where the agent's terminal (Claude Code, Codex) put a picture it took out of
 * the words, its path gone. Each is a token for one of the message's `count` pictures, in the
 * order they're named (the number counts the conversation's pictures, not this message's):
 * "@Picture" for one, "@Picture-1", "@Picture-2" … for several. `tokens[k]` is the k-th picture's.
 */
export function namePictures(text: string, count: number): { text: string; tokens: string[] } {
  const tokens: string[] = [];
  if (!count) return { text, tokens };
  const named = text.replace(/\[Image #\d+\]/g, (mark, at: number, all: string) => {
    if (tokens.length >= count) return mark;
    const token = count === 1 ? 'Picture' : `Picture-${tokens.length + 1}`;
    tokens.push(token);
    // A token stands apart from what's around it ("[Image #3]/home/…" came glued).
    const before = at > 0 && !/\s/.test(all[at - 1]) ? ' ' : '';
    const after = at + mark.length < all.length && !/\s/.test(all[at + mark.length]) ? ' ' : '';
    return `${before}@${token}${after}`;
  });
  return { text: tokens.length ? named : text, tokens };
}
