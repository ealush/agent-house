// A file attached from the composer reaches the agent as its path in ah's upload
// folder, shell-quoted when it needs it. Wherever ah shows that message back to you
// (the feed, the queue tray, the composer on Edit) it reads as the attachment instead.

const UPLOAD = /(?<=^|\s)(?:'([^']*\/ah\/uploads\/[^'/]+)'|(\/\S*\/ah\/uploads\/[^\s/]+))(?=\s|$)/g;
const IMAGE = /\.(?:png|jpe?g|gif|webp|avif)$/i;

export type Upload = { path: string; name: string; image: boolean };

/** The uploads a message carries, and its text without them. */
export function splitUploads(text: string): { uploads: Upload[]; rest: string } {
  const uploads = [...text.matchAll(UPLOAD)].map((m) => {
    const path = m[1] ?? m[2];
    // Saved as "<timestamp>-<name>": show the name you gave it.
    const name = path.slice(path.lastIndexOf('/') + 1).replace(/^\d{4}-\d\d-\d\dT[\d-]+Z-/, '');
    return { path, name, image: IMAGE.test(path) };
  });
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
