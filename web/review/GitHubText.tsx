import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { age } from '../agents.ts';

/** Turns a GitHub image URL into one this page can load (through ah), or null when it isn't GitHub's. */
export type ImageUrl = (src: string) => string | null;

// GitHub's own allow-list (rehype-sanitize's default is GitHub's): <details>, <sub>, <kbd>, <img>,
// tables, task lists; no scripts, styles or event handlers, ids prefixed.
const REHYPE = [rehypeRaw, [rehypeSanitize, defaultSchema]] as const;
const REMARK = [remarkGfm];

/** The hosts GitHub serves a repo's files and uploads from; ah reads them with its gh login. */
export const fromGitHub = (src: string) => {
  try {
    const u = new URL(src);
    return u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com'));
  } catch {
    return false;
  }
};

type Element = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: Element[] };

const text = (n: unknown): string => {
  const x = n as { type?: string; value?: string; children?: unknown[] };
  return x.type === 'text' ? (x.value ?? '') : (x.children ?? []).map(text).join('');
};

/**
 * Markdown as GitHub shows it, for what comes from GitHub: PR descriptions and
 * review comments. GFM plus GitHub's safe HTML. Images on GitHub come through
 * ah (the page loads images only from ah); any other image is its alt text, as
 * a link. A ```suggestion block reads as the change it suggests.
 */
export const GitHubText = memo(function GitHubText({ text: md, image }: { text: string; image: ImageUrl }) {
  const components: Components = {
    // A path is GitHub's (/owner/repo/pull/1), not ah's.
    a: ({ href = '', children }: { href?: string; children?: ReactNode }) =>
      href ? (
        <a href={href.startsWith('/') && !href.startsWith('//') ? `https://github.com${href}` : href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      ) : (
        <>{children}</>
      ),
    img: ({ src, alt, width, height }) => {
      const url = typeof src === 'string' ? src : '';
      const local = url && fromGitHub(url) ? image(url) : null;
      if (!local)
        return url ? (
          <a className="gh-img-out" href={url} target="_blank" rel="noreferrer noopener" title={url}>
            {alt || 'Image'}
          </a>
        ) : null;
      return <GhImage url={url} local={local} alt={alt ?? ''} width={width} height={height} />;
    },
    table: ({ children }) => (
      <div className="md-table">
        <table>{children}</table>
      </div>
    ),
    pre: ({ node, children }) => {
      const code = (node as Element | undefined)?.children?.[0] as Element | undefined;
      const cls = code?.properties?.className;
      if (Array.isArray(cls) && cls.includes('language-suggestion')) {
        const lines = text(code).replace(/\n$/, '').split('\n');
        return (
          <div className="gh-suggestion">
            <div className="gh-suggestion-head">Suggested change</div>
            <pre>
              {lines.map((l, i) => (
                <span key={i} className="add">
                  {l || ' '}
                  {'\n'}
                </span>
              ))}
            </pre>
          </div>
        );
      }
      return <pre>{children}</pre>;
    },
  };
  return (
    <div className="md gh-md">
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE as never} components={components}>
        {md}
      </ReactMarkdown>
    </div>
  );
});

/** A GitHub image through ah; a click opens the original. One ah can't read is its alt text, as a link. */
function GhImage({ url, local, alt, width, height }: { url: string; local: string; alt: string; width?: string | number; height?: string | number }) {
  const [failed, setFailed] = useState(false);
  return (
    <a className={failed ? 'gh-img-out' : 'gh-img'} href={url} target="_blank" rel="noreferrer noopener" title="Open on GitHub">
      {failed ? alt || 'Image' : <img src={local} alt={alt} width={width} height={height} loading="lazy" onError={() => setFailed(true)} />}
    </a>
  );
}

/** Who wrote a GitHub comment, as a person reads it: bots by name, not login. */
export const commenter = (login: string) => login.replace(/^chatgpt-codex-connector(\[bot\])?$/, 'Codex').replace(/^coderabbitai(\[bot\])?$/, 'CodeRabbit').replace(/\[bot\]$/, '');

const when = (ms: number) => {
  const a = age(Math.floor(ms / 1000));
  return a === 'now' ? 'just now' : /^\d+[mh]$/.test(a) ? `${a} ago` : a;
};

const REPLY = /^<!-- ah:reply (\S*) (\S*) -->\n?/m;

/**
 * An imported GitHub thread: the first comment, then each reply as its own
 * comment with who wrote it and when (server/review/service.ts replyMark).
 */
export function GitHubThread({ body, image }: { body: string; image: ImageUrl }) {
  const parts = body.split(REPLY);
  const replies: { author: string; at: string; text: string }[] = [];
  for (let i = 1; i + 2 < parts.length + 1; i += 3) replies.push({ author: parts[i], at: parts[i + 1], text: (parts[i + 2] ?? '').trim() });
  return (
    <div className="gh-thread">
      {parts[0].trim() && <GitHubText text={parts[0].trim()} image={image} />}
      {replies.map((r, i) => {
        const at = Date.parse(r.at);
        return (
          <div className="gh-reply" key={i}>
            <div className="gh-reply-head">
              <span className="who">{commenter(r.author)}</span>
              {Number.isFinite(at) && <span className="when">{when(at)}</span>}
            </div>
            <GitHubText text={r.text} image={image} />
          </div>
        );
      })}
    </div>
  );
}
