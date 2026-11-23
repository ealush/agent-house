import { memo, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const PLUGINS = [remarkGfm];

const FILE = /^file:/i;
// `file:` URLs reach the link renderers (the GUI opens them on the host); every other
// unsafe URL is dropped as react-markdown does by default.
const urlTransform = (url: string) => (FILE.test(url) ? url : defaultUrlTransform(url));

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
  plugins,
}: {
  text: string;
  resolveHref?: (href: string) => string | null;
  /** Replaces a default element. The GUI uses this to put a copy button on code blocks. */
  components?: Components;
  /** More remark plugins, after GFM (the GUI's @mentions). */
  plugins?: Options['remarkPlugins'];
}) {
  const components: Components = {
    a: ({ href = '', children }: { href?: string; children?: ReactNode }) => {
      // A `file:` link means a file on the host; without a renderer that knows the host, it's text.
      const to = resolveHref ? resolveHref(href) : FILE.test(href) ? null : href;
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
      <ReactMarkdown remarkPlugins={plugins ? [...PLUGINS, ...plugins] : PLUGINS} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
