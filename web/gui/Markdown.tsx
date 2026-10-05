import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useGui } from './context.ts';

const PLUGINS = [remarkGfm];

/** Local paths (`/home/…`, `~/…`) open through the files API instead of the web. */
function isLocalPath(href: string) {
  return /^(\/(?!\/)|~\/)/.test(href);
}

/**
 * Agent prose is already markdown: tables, links, lists and code come free.
 * Raw HTML is never rendered (react-markdown's default) and unsafe URLs are dropped.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const gui = useGui();
  const components: Components = {
    a: ({ href = '', children }) => {
      const local = isLocalPath(href);
      return (
        <a href={local ? gui.fileUrl(gui.resolvePath(href.replace(/:\d+(:\d+)?$/, ''))) : href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      );
    },
    table: ({ children }) => (
      <div className="md-table">
        <table>{children}</table>
      </div>
    ),
    img: ({ alt }) => <span className="md-img">{alt ? `[image: ${alt}]` : '[image]'}</span>,
  };
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
