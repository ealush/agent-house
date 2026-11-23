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
