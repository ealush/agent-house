import { memo, useMemo } from 'react';
import { MENTION_HREF, SESSION_HREF, remarkMentions, remarkSessionChips, resolveMention, useFileMentions } from '../mentions.ts';
import { Markdown as SharedMarkdown } from '../Markdown.tsx';
import { runsLanguage } from '../runInShell.ts';
import { CodeBlock } from './CodeBlock.tsx';
import { useGui } from './context.ts';
import { linkedPath, mediaKind } from '../media.ts';

/** A fence's language, from its `<code class="language-sh">`; empty for none. */
function fenceLanguage(node: unknown): string {
  const code = (node as { children?: Array<{ properties?: { className?: unknown } }> } | undefined)?.children?.[0];
  const names = code?.properties?.className;
  const name = (Array.isArray(names) ? names : []).map(String).find((c) => c.startsWith('language-'));
  return name ? name.slice('language-'.length) : '';
}

/**
 * Agent prose is already markdown: tables, links, lists and code come free.
 * Shares the hardened renderer; only link routing is GUI-specific.
 */
/** A picture's chip: its place among the message's pictures (`pictures`), not a path. */
const PICTURE = 'ah-picture:';

export const Markdown = memo(function Markdown({ text, uploads, pictures, onPicture }: { text: string; uploads?: Map<string, string>; pictures?: Map<string, number>; onPicture?: (at: number) => void }) {
  const gui = useGui();
  const m = gui.mentions;
  // "@path" naming a file that's there: a chip that opens it, here as in the composer. And
  // your attachments where you put them (`uploads`: token → its path on the host).
  const found = useFileMentions(m?.fs ?? null, m?.cwd, text);
  const files = new Map(m ? found.map((f) => [f.path, resolveMention(m.cwd, f.path)] as const) : []);
  for (const [token, path] of uploads ?? []) files.set(token, path);
  for (const [token, at] of onPicture ? (pictures ?? []) : []) files.set(token, `${PICTURE}${at}`);
  const sessionLookup = gui.sessions?.lookup;
  const key = [...files].map(([k, v]) => `${k}\t${v}`).sort().join('\n');
  const sessionKey = sessionLookup ? [...sessionLookup.values()].map((s) => `${s.uid}\t${s.title}`).sort().join('\n') : '';
  const plugins = useMemo(() => {
    const out: NonNullable<Parameters<typeof SharedMarkdown>[0]['plugins']> = [];
    if (key) out.push(remarkMentions(new Map(key.split('\n').map((l) => l.split('\t') as [string, string]))));
    if (sessionLookup && sessionLookup.size > 0) out.push(remarkSessionChips(sessionLookup));
    return out.length ? out : undefined;
  }, [key, sessionKey]);
  return (
    <SharedMarkdown
      text={text}
      plugins={plugins}
      components={{
        pre: ({ children, node }) => <CodeBlock runnable={runsLanguage(fenceLanguage(node))}>{children}</CodeBlock>,
        a: ({ href = '', children }) => {
          if (gui.sessions && href.startsWith(SESSION_HREF)) {
            const uid = decodeURIComponent(href.slice(SESSION_HREF.length));
            const info = gui.sessions.lookup.get(uid);
            return (
              <a
                className="mention-chip session-chip"
                href={`#${encodeURIComponent(uid)}`}
                title={`Open session ${info?.title ?? uid} (${uid})`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  gui.sessions!.open(uid);
                }}
              >
                {info?.status && <span className={`dot ${info.status}`} />}
                <span>{info?.role === 'chief' ? '♛ ' : '#'}{children}</span>
              </a>
            );
          }
          const named = href.startsWith(MENTION_HREF) ? decodeURIComponent(href.slice(MENTION_HREF.length)) : null;
          if (named?.startsWith(PICTURE) && onPicture) {
            const at = Number(named.slice(PICTURE.length));
            return (
              // The picture, in the gallery with the message's others.
              <a className="mention-chip" href={href} role="button" onClick={(e) => {
                e.preventDefault();
                onPicture(at);
              }}>
                {children}
              </a>
            );
          }
          if (m && href.startsWith(MENTION_HREF)) {
            const path = decodeURIComponent(href.slice(MENTION_HREF.length));
            return (
              // A link still: a new tab with a modifier, the preview with a plain click or tap.
              <a className="mention-chip" href={gui.fileUrl(path)} title={path} onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                m.open(path);
              }}>
                {children}
              </a>
            );
          }
          // Files on the host (`/home/…`, `~/…`, `file://…`) open through the files API instead
          // of the web; pictures, video and sound in the media viewer, like a chip.
          const local = linkedPath(href);
          const path = local && gui.resolvePath(local);
          if (path && gui.media && mediaKind(path)) {
            const media = gui.media;
            return (
              <a href={media.url(path)} title={path} onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                media.open(path);
              }}>
                {children}
              </a>
            );
          }
          const to = path ? gui.fileUrl(path) : href;
          if (!to) return <>{children}</>;
          return (
            <a href={to} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          );
        },
      }}
    />
  );
});

