import { useEffect, useId, useState, type ReactNode } from 'react';

// A ```mermaid fence, drawn: the diagram an agent wrote, not its source. Mermaid is big, so it
// comes the first time a page shows one (its own chunk, bundled: no third-party origin), and
// draws with `securityLevel: 'strict'` (no HTML labels, no click handlers, its output sanitized).
type Mermaid = typeof import('mermaid').default;
let loading: Promise<Mermaid> | null = null;
const load = () => (loading ??= import('mermaid').then((m) => m.default));

/** The page's theme as theme.ts resolved it, followed as it changes. */
function useResolvedTheme(): 'light' | 'dark' {
  const read = (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const watch = new MutationObserver(() => setTheme(read()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => watch.disconnect();
  }, []);
  return theme;
}

// One diagram at a time: mermaid's settings are global, and two drawing at once under two
// themes would trade them.
let queue: Promise<unknown> = Promise.resolve();
// Each drawing under an id of its own: mermaid first removes whatever has the id it's given,
// which would be the drawing on show while the next (another theme) is made.
let drawn = 0;

async function draw(id: string, code: string, theme: 'light' | 'dark'): Promise<string> {
  const mermaid = await load();
  const run = queue.then(async () => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme === 'dark' ? 'dark' : 'default', fontFamily: 'inherit' });
    return (await mermaid.render(`${id}-${++drawn}`, code)).svg;
  });
  queue = run.catch(() => {});
  return run;
}

/**
 * The diagram, with Source for what it's drawn from (`fallback`: the code block, its copy
 * button with it). One mermaid can't read shows that code block, saying so.
 */
export function MermaidDiagram({ code, fallback }: { code: string; fallback: ReactNode }) {
  const theme = useResolvedTheme();
  const id = `mermaid-${useId().replace(/[^\w-]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    draw(id, code, theme).then(
      (out) => live && setSvg(out),
      () => {
        // Mermaid leaves its error drawing in the page; it isn't ours to show.
        for (const left of document.querySelectorAll(`body > [id^="d${id}-"]`)) left.remove();
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [id, code, theme]);
  if (failed) {
    return (
      <div className="mermaid-block failed">
        {fallback}
        <p className="mermaid-note">Couldn’t draw this diagram.</p>
      </div>
    );
  }
  return (
    <div className="mermaid-block">
      {source ? (
        fallback
      ) : svg ? (
        // Mermaid's own output, sanitized under `strict` (DOMPurify): an SVG with no script.
        <div className="mermaid-diagram" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="mermaid-diagram loading" aria-busy="true">
          Drawing…
        </div>
      )}
      <button type="button" className="mermaid-toggle btn ghost small" aria-label={source ? 'Show the diagram' : "The diagram's source"} onClick={() => setSource((s) => !s)}>
        {source ? 'Diagram' : 'Source'}
      </button>
    </div>
  );
}

/** A fence's language and text, from its hast `<pre><code class="language-…">`. */
export function fenceOf(node: unknown): { language: string; text: string } {
  const code = (node as { children?: Array<{ properties?: { className?: unknown }; children?: Array<{ value?: unknown }> }> } | undefined)?.children?.[0];
  const names = code?.properties?.className;
  const name = (Array.isArray(names) ? names : []).map(String).find((c) => c.startsWith('language-'));
  const text = (code?.children ?? []).map((c) => (typeof c.value === 'string' ? c.value : '')).join('');
  return { language: name ? name.slice('language-'.length) : '', text: text.replace(/\n$/, '') };
}
