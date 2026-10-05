import { memo } from 'react';
import { Markdown as SharedMarkdown } from '../Markdown.tsx';
import { useGui } from './context.ts';

/** Local paths (`/home/…`, `~/…`) open through the files API instead of the web. */
function isLocalPath(href: string) {
  return /^(\/(?!\/)|~\/)/.test(href);
}

/**
 * Agent prose is already markdown: tables, links, lists and code come free.
 * Shares the hardened renderer; only link routing is GUI-specific.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const gui = useGui();
  return (
    <SharedMarkdown
      text={text}
      resolveHref={(href) => (isLocalPath(href) ? gui.fileUrl(gui.resolvePath(href.replace(/:\d+(:\d+)?$/, ''))) : href)}
    />
  );
});
