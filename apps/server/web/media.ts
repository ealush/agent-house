// Media in the conversation: a link to a picture, video or sound on the host opens in the
// media viewer (web/FilePreview.tsx), streamed from GET /api/fs/media. Pure functions.

export type MediaKind = 'image' | 'video' | 'audio';

// What the host streams (server/files.ts MEDIA), by what a browser can show it as.
const KINDS: Array<[RegExp, MediaKind]> = [
  [/\.(png|jpe?g|gif|webp|avif|heic|heif)$/i, 'image'],
  [/\.(mp4|m4v|mov|webm|ogv)$/i, 'video'],
  [/\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i, 'audio'],
];

/** How a path plays in the viewer, by its extension; null for anything that isn't media. */
export function mediaKind(path: string): MediaKind | null {
  return KINDS.find(([re]) => re.test(path))?.[1] ?? null;
}

/**
 * The host path a link names: a `file://` URL (agents write them for files on the host), or a
 * local path (`/home/…`, `~/…`) without a `:line:col` suffix; percent-escapes decoded (Markdown
 * escapes a space in a link). Null for anything else.
 */
export function linkedPath(href: string): string | null {
  const file = href.match(/^file:\/\/(?:localhost)?(\/[^?#]*)/i);
  const path = file ? file[1] : /^(\/(?!\/)|~\/)/.test(href) ? href.replace(/:\d+(:\d+)?$/, '') : null;
  if (!path) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** A Markdown document, which the file viewer shows rendered (web/FilePreview.tsx). */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}

/**
 * The host path a link or picture in a Markdown document names, read where the document is
 * (`dir`, its folder): a host path or `file://` URL as `linkedPath` reads it, or a relative one
 * (`evidence/shot.png`, `../README.md`) joined to `dir`, its `?query` and `#anchor` dropped.
 * Null for a web URL, a bare anchor, or anything else that isn't a file on the host.
 */
export function linkedPathIn(href: string, dir: string): string | null {
  const absolute = linkedPath(href);
  if (absolute) return absolute;
  if (!href || /^[a-z][\w+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//') || href.startsWith('/')) return null;
  let rel = href.replace(/[?#].*$/, '');
  try {
    rel = decodeURIComponent(rel);
  } catch {
    // A stray % stays.
  }
  if (!rel) return null;
  const parts = dir.replace(/\/+$/, '').split('/');
  for (const part of rel.split('/')) {
    if (part === '..') {
      if (parts.length > 1) parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/') || '/';
}

/** The folder a host path is in. */
export function folderOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at > 0 ? path.slice(0, at) : '/';
}
