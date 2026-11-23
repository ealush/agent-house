import { useEffect, useState } from 'react';
import type { HostApi } from './api.ts';
import { Sheet } from './sheet.tsx';
import { errorText } from './errors.ts';
import { mediaKind, type MediaKind } from './media.ts';

// A file on the session's host, read where you are: an @mention's chip in the composer or
// the feed opens it here, and so does a link to a picture, video or sound. Text and images
// show, video and sound play (streamed, when the host streams media: `media`); anything else
// offers the download.
const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;
const MAX = 1024 * 1024;

type Shown = { image: true } | { media: MediaKind } | { text: string } | { note: string };

export function FilePreview({ fs, path, title, media, onClose }: { fs: HostApi['fs']; path: string; title?: string; media?: boolean; onClose: () => void }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const kind = media ? mediaKind(path) : null;
  const src = kind ? fs.media(path) : fs.url(path);
  useEffect(() => {
    const ask = new AbortController();
    if (kind) {
      // Ask for its first byte: the host's own words when it won't serve it (outside the
      // folders it serves, not media), before the player says only that it can't play.
      void fetch(fs.media(path), { headers: { range: 'bytes=0-0' }, signal: ask.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
          void res.body?.cancel();
          setShown({ media: kind });
        })
        .catch((e) => !ask.signal.aborted && setShown({ note: `Couldn’t open it: ${errorText(e)}` }));
      return () => ask.abort();
    }
    if (IMAGE.test(path)) return setShown({ image: true });
    void (async () => {
      try {
        const res = await fetch(fs.url(path), { signal: ask.signal });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
        const size = Number(res.headers.get('content-length') ?? 0);
        if (!(res.headers.get('content-type') ?? '').startsWith('text/')) return setShown({ note: 'Not a text file. Download it to open it.' });
        if (size > MAX) return setShown({ note: 'Too large to show here. Download it instead.' });
        const text = await res.text();
        setShown(text.length > MAX ? { note: 'Too large to show here. Download it instead.' } : { text });
      } catch (e) {
        if (!ask.signal.aborted) setShown({ note: `Couldn’t open it: ${errorText(e)}` });
      }
    })();
    return () => ask.abort();
  }, [fs, path, kind]);
  const name = title ?? path.slice(path.lastIndexOf('/') + 1);
  return (
    <Sheet label={name} className="file-preview" onClose={onClose}>
      <div className="file-preview-head">
        <span className="file-preview-path mono" title={path}>{path}</span>
        <a className="btn ghost small" href={kind ? src : fs.url(path, true)} download={kind ? name : true}>
          Download
        </a>
        <button type="button" className="btn ghost small file-preview-close" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="file-preview-body">
        {!shown ? (
          <p className="muted small">Loading…</p>
        ) : 'image' in shown || ('media' in shown && shown.media === 'image') ? (
          <img src={src} alt={name} />
        ) : 'media' in shown && shown.media === 'video' ? (
          <video src={src} controls autoPlay playsInline preload="metadata" />
        ) : 'media' in shown ? (
          <audio src={src} controls autoPlay preload="metadata" />
        ) : 'text' in shown ? (
          <pre>{shown.text}</pre>
        ) : (
          <p className="muted small">{shown.note}</p>
        )}
      </div>
    </Sheet>
  );
}
