import { useEffect, useRef, useState, type ReactNode } from 'react';
import { showNotice } from '../ask.tsx';
import { Icon } from '../icons.tsx';
import { copyText } from '../selection.ts';

/** A fenced block or tool snippet, with a button that copies just that text. */
export function CodeBlock({ children, className, text }: { children?: ReactNode; className?: string; text?: string }) {
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  // A passed string wins (a shell line drops the "$ " prompt). Otherwise the
  // rendered text, minus the newline a markdown fence leaves on the last line.
  const source = () => (text ?? pre.current?.innerText ?? '').replace(/\n$/, '');
  return (
    <div className="code-snippet">
      <pre ref={pre} className={className}>
        {children}
      </pre>
      <button
        type="button"
        className="code-copy"
        aria-label={copied ? 'Copied' : 'Copy code'}
        title={copied ? 'Copied' : 'Copy code'}
        onClick={() => {
          const value = source();
          if (!value) return;
          void copyText(value).then((ok) => {
            if (ok) setCopied(true);
            else showNotice('Copy failed', 'Select the text and copy it yourself.');
          });
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
    </div>
  );
}
