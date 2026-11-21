import { useEffect, useState } from 'react';
import type { HostApi } from './api.ts';
import { Sheet } from './sheet.tsx';
import { errorText } from './errors.ts';

// A file on the session's host, read where you are: an @mention's chip in the composer or
// the feed opens it here. Text and images show; anything else offers the download.
const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;
const MAX = 1024 * 1024;

type Shown = { image: true } | { text: string } | { note: string };

export function FilePreview({ fs, path, title, onClose }: { fs: HostApi['fs']; path: string; title?: string; onClose: () => void }) {
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    if (IMAGE.test(path)) return setShown({ image: true });
    const ask = new AbortController();
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
  }, [fs, path]);
  const name = title ?? path.slice(path.lastIndexOf('/') + 1);
  return (
    <Sheet label={name} className="file-preview" onClose={onClose}>
      <div className="file-preview-head">
        <span className="file-preview-path mono" title={path}>{path}</span>
        <a className="btn ghost small" href={fs.url(path, true)} download>
          Download
        </a>
        <button type="button" className="btn ghost small file-preview-close" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="file-preview-body">
        {!shown ? (
          <p className="muted small">Loading…</p>
        ) : 'image' in shown ? (
          <img src={fs.url(path)} alt={name} />
        ) : 'text' in shown ? (
          <pre>{shown.text}</pre>
        ) : (
          <p className="muted small">{shown.note}</p>
        )}
      </div>
    </Sheet>
  );
}
