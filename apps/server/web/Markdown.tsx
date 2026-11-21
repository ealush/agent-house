import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const PLUGINS = [remarkGfm];

/**
 * Model markdown: GFM tables, links, lists and code come free. Raw HTML is
 * never rendered (react-markdown's default) and unsafe URLs are dropped.
 * Pass resolveHref to route links somewhere custom (the GUI opens repo paths
 * through the files API); returning null renders the text without a link.
 */
export const Markdown = memo(function Markdown({
  text,
  resolveHref,
  components: extra,
}: {
  text: string;
  resolveHref?: (href: string) => string | null;
  /** Replaces a default element. The GUI uses this to put a copy button on code blocks. */
  components?: Components;
}) {
  const components: Components = {
    a: ({ href = '', children }: { href?: string; children?: ReactNode }) => {
      const to = resolveHref ? resolveHref(href) : href;
      if (to === null || !to) return <>{children}</>;
      return (
        <a href={to} target="_blank" rel="noreferrer noopener">
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
    ...extra,
  };
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
