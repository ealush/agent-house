import { useEffect, useState } from 'react';
import type { HostApi } from './api.ts';
import { Sheet } from './sheet.tsx';
import { errorText } from './errors.ts';
import { Markdown } from './Markdown.tsx';
import { MermaidDiagram, fenceOf } from './Mermaid.tsx';
import { CodeBlock } from './gui/CodeBlock.tsx';
import { folderOf, isMarkdownPath, linkedPathIn, mediaKind, type MediaKind } from './media.ts';
import './gui/gui.css';

// A file on the session's host, read where you are: an @mention's chip in the composer or
// the feed opens it here, and so does a link to a file on the host. Text and images show, a
// Markdown document reads as it's meant to (its pictures drawn, its links followed here, Back
// returning), video and sound play (streamed, when the host streams media: `media`); anything
// else offers the download.
const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;
const MAX = 1024 * 1024;

type Shown = { image: true } | { media: MediaKind } | { text: string } | { note: string };

export function FilePreview({ fs, path: first, title, media, onClose }: { fs: HostApi['fs']; path: string; title?: string; media?: boolean; onClose: () => void }) {
  // The files followed from a document's links, the one shown last: Back goes down the trail.
  const [trail, setTrail] = useState([first]);
  const path = trail[trail.length - 1];
  const [shown, setShown] = useState<Shown | null>(null);
  const [source, setSource] = useState(false);
  const kind = media ? mediaKind(path) : null;
  const src = kind ? fs.media(path) : fs.url(path);
  useEffect(() => {
    setShown(null);
    setSource(false);
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
  const name = trail.length === 1 && title ? title : path.slice(path.lastIndexOf('/') + 1);
  const markdown = isMarkdownPath(path) && shown && 'text' in shown;
  return (
    <Sheet label={name} className="file-preview" onClose={onClose}>
      <div className="file-preview-head">
        {trail.length > 1 && (
          <button type="button" className="btn ghost small" onClick={() => setTrail((t) => t.slice(0, -1))}>
            Back
          </button>
        )}
        <span className="file-preview-path mono" title={path}>{path}</span>
        {markdown && (
          <button type="button" className="btn ghost small" aria-pressed={source} onClick={() => setSource((s) => !s)}>
            {source ? 'Rendered' : 'Source'}
          </button>
        )}
        <a className="btn ghost small" href={kind ? src : fs.url(path, true)} download={kind ? name : true}>
          Download
        </a>
        <button type="button" className="btn ghost small file-preview-close" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="file-preview-body" key={path}>
        {!shown ? (
          <p className="muted small">Loading…</p>
        ) : 'image' in shown || ('media' in shown && shown.media === 'image') ? (
          <img src={src} alt={name} />
        ) : 'media' in shown && shown.media === 'video' ? (
          <video src={src} controls autoPlay playsInline preload="metadata" />
        ) : 'media' in shown ? (
          <audio src={src} controls autoPlay preload="metadata" />
        ) : 'text' in shown && markdown && !source ? (
          <MarkdownFile text={shown.text} dir={folderOf(path)} fs={fs} media={media} open={(to) => setTrail((t) => [...t, to])} />
        ) : 'text' in shown ? (
          <pre>{shown.text}</pre>
        ) : (
          <p className="muted small">{shown.note}</p>
        )}
      </div>
    </Sheet>
  );
}

/**
 * A Markdown document as it reads: its diagrams drawn, its pictures on the host drawn (relative
 * ones from its own folder), its links to files on the host opened here. A picture on the web isn't fetched (its
 * address can carry what the document says to whoever serves it): it's a link, as in a message.
 */
function MarkdownFile({ text, dir, fs, media, open }: { text: string; dir: string; fs: HostApi['fs']; media?: boolean; open: (path: string) => void }) {
  return (
    // Under .gui: a message's Markdown look (gui/gui.css), at a page's width.
    <div className="file-preview-doc gui">
      <Markdown
        text={text}
        resolveHref={(href) => href}
        components={{
          pre: ({ children, node }) => {
            const fence = fenceOf(node);
            const block = <CodeBlock>{children}</CodeBlock>;
            return fence.language === 'mermaid' ? <MermaidDiagram code={fence.text} fallback={block} /> : block;
          },
          img: ({ src = '', alt }) => {
            const at = typeof src === 'string' ? linkedPathIn(src, dir) : null;
            if (at && (mediaKind(at) === 'image' || IMAGE.test(at))) {
              return <img className="md-picture" src={media && mediaKind(at) ? fs.media(at) : fs.url(at)} alt={alt ?? ''} loading="lazy" />;
            }
            return <span className="md-img">{alt ? `[image: ${alt}]` : '[image]'}</span>;
          },
          a: ({ href = '', children }) => {
            const at = linkedPathIn(href, dir);
            if (!at) {
              return /^(https?|mailto):/i.test(href) ? (
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {children}
                </a>
              ) : (
                <>{children}</>
              );
            }
            return (
              // A link still: a new tab with a modifier, here with a plain click or tap.
              <a href={fs.url(at)} title={at} onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                open(at);
              }}>
                {children}
              </a>
            );
          },
        }}
      />
    </div>
  );
}
