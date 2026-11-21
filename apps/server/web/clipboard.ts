// Clipboard screenshots (F24 follow-up): a copied screenshot often arrives via
// `clipboardData.items` with an EMPTY `files` list (Safari, screenshot tools),
// so checking `files` alone silently drops the paste. This collects both,
// deduped, with a usable filename for nameless clipboard images.
export type ClipboardLike = {
  files: ArrayLike<File>;
  items: ArrayLike<{ kind: string; type: string; getAsFile: () => File | null }>;
};

const key = (f: Pick<File, 'name' | 'size' | 'type'>) => `${f.type}\0${f.size}\0${f.name}`;

const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

export function withName(f: File, fallback: string): File {
  if (f.name) return f;
  const ext = EXT[f.type] ?? '';
  try {
    return new File([f], `${fallback}${ext}`, { type: f.type, lastModified: f.lastModified });
  } catch {
    return f;
  }
}

export function clipboardFiles(dt: ClipboardLike): File[] {
  const out = Array.from(dt.files);
  const seen = new Set(out.map(key));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let unnamed = 0;
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue;
    const f = item.getAsFile();
    if (!f || seen.has(key(f))) continue;
    seen.add(key(f));
    out.push(f.name ? f : withName(f, unnamed ? `screenshot-${stamp}-${unnamed}` : `screenshot-${stamp}`));
    if (!f.name) unnamed++;
  }
  return out;
}

/** Read text or screenshots from an explicit Paste button click. */
export async function readClipboard(clipboard: Pick<Clipboard, 'read' | 'readText'> | undefined): Promise<{ text: string; files: File[] }> {
  if (!clipboard) throw new Error('Clipboard unavailable');
  if (typeof clipboard.read === 'function') {
    try {
      const items = await clipboard.read();
      const files: File[] = [];
      let text = '';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          files.push(new File([blob], `screenshot-${stamp}-${files.length + 1}${EXT[type] ?? ''}`, { type }));
        } else if (item.types.includes('text/plain')) {
          text += await (await item.getType('text/plain')).text();
        }
      }
      return { text, files };
    } catch (e) {
      // Some browsers support text reads but restrict rich clipboard reads.
      if (typeof clipboard.readText !== 'function') throw e;
    }
  }
  return { text: await clipboard.readText(), files: [] };
}
