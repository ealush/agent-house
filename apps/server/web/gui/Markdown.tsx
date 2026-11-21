import { memo, useMemo } from 'react';
import { MENTION_HREF, remarkMentions, resolveMention, useFileMentions } from '../mentions.ts';
import { Markdown as SharedMarkdown } from '../Markdown.tsx';
import { runsLanguage } from '../runInShell.ts';
import { CodeBlock } from './CodeBlock.tsx';
import { useGui } from './context.ts';

/** A fence's language, from its `<code class="language-sh">`; empty for none. */
function fenceLanguage(node: unknown): string {
  const code = (node as { children?: Array<{ properties?: { className?: unknown } }> } | undefined)?.children?.[0];
  const names = code?.properties?.className;
  const name = (Array.isArray(names) ? names : []).map(String).find((c) => c.startsWith('language-'));
  return name ? name.slice('language-'.length) : '';
}

/** Local paths (`/home/…`, `~/…`) open through the files API instead of the web. */
function isLocalPath(href: string) {
  return /^(\/(?!\/)|~\/)/.test(href);
}

/**
 * Agent prose is already markdown: tables, links, lists and code come free.
 * Shares the hardened renderer; only link routing is GUI-specific.
 */
export const Markdown = memo(function Markdown({ text, uploads }: { text: string; uploads?: Map<string, string> }) {
  const gui = useGui();
  const m = gui.mentions;
  // "@path" naming a file that's there: a chip that opens it, here as in the composer. And
  // your attachments where you put them (`uploads`: token → its path on the host).
  const found = useFileMentions(m?.fs ?? null, m?.cwd, text);
  const files = new Map(m ? found.map((f) => [f.path, resolveMention(m.cwd, f.path)] as const) : []);
  for (const [token, path] of uploads ?? []) files.set(token, path);
  const key = [...files].map(([k, v]) => `${k}\t${v}`).sort().join('\n');
  const plugins = useMemo(() => (key ? [remarkMentions(new Map(key.split('\n').map((l) => l.split('\t') as [string, string])))] : undefined), [key]);
  return (
    <SharedMarkdown
      text={text}
      plugins={plugins}
      components={{
        pre: ({ children, node }) => <CodeBlock runnable={runsLanguage(fenceLanguage(node))}>{children}</CodeBlock>,
        a: ({ href = '', children }) => {
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
          // Local paths (`/home/…`, `~/…`) open through the files API instead of the web.
          const to = isLocalPath(href) ? gui.fileUrl(gui.resolvePath(href.replace(/:\d+(:\d+)?$/, ''))) : href;
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

