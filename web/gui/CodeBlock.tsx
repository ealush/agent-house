import { useEffect, useRef, useState, type ReactNode } from 'react';
import { showNotice } from '../ask.tsx';
import { Icon } from '../icons.tsx';
import { copyText } from '../selection.ts';
import { useGui } from './context.ts';

/**
 * A fenced block or tool snippet, with a button that copies just that text. A `runnable` one
 * (a shell's code, a command the agent ran) also offers Run in Terminal in a live session.
 */
export function CodeBlock({ children, className, text, runnable }: { children?: ReactNode; className?: string; text?: string; runnable?: boolean }) {
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const { snippetRun } = useGui();
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  // A passed string wins (a shell line drops the "$ " prompt). Otherwise the
  // rendered text, minus the newline a markdown fence leaves on the last line.
  const source = () => (text ?? pre.current?.innerText ?? '').replace(/\n$/, '');
  const run = runnable && !className?.includes('error') ? snippetRun : undefined;
  return (
    <div className={`code-snippet${run ? ' runs' : ''}`}>
      <pre ref={pre} className={className}>
        {children}
      </pre>
      {run && (
        <button
          type="button"
          className="code-run"
          aria-label="Send to terminal"
          title={`Send to this session's terminal and run in ${run.place}`}
          onClick={() => {
            const value = source();
            if (value) run.run(value);
          }}
        >
          <Icon name="terminal" size={13} />
        </button>
      )}
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
