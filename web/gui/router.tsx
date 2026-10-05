// Dispatch from typed content to components: part type → renderer here, tool name
// → web/gui/tools.tsx, widget type → web/gui/widgets.tsx. No string matching on prose.
import { useState, type ReactNode } from 'react';
import type { Part, ToolResult } from '../../server/feed/schema.ts';
import type { Item } from './reducer.ts';
import { Markdown } from './Markdown.tsx';
import { WidgetView } from './widgets.tsx';
import { ToolGroup } from './tools.tsx';

type PartOf<T extends Part['type']> = Extract<Part, { type: T }>;
type PartRenderers = { [T in Part['type']]: (p: PartOf<T>) => ReactNode };

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`reasoning ${open ? 'open' : ''}`}>
      <button className="reasoning-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        Thinking <span aria-hidden>›</span>
      </button>
      {open && <Markdown text={text} />}
    </div>
  );
}

const PARTS: PartRenderers = {
  text: (p) => <Markdown text={p.text} />,
  reasoning: (p) => <Reasoning text={p.text} />,
  media: (p) => <img className="widget-img" src={p.src} alt={p.alt ?? ''} />,
  widget: (p) => <WidgetView widget={p.widget} />,
  notice: (p) => <div className={`notice ${p.kind}`}>{p.text}</div>,
  // Folded into their call by the reducer; never shown on their own.
  tool_result: () => null,
  tool_call: () => null,
};

export function PartView({ part }: { part: Part }) {
  return <>{(PARTS[part.type] as (p: Part) => ReactNode)(part)}</>;
}

export function ItemView({ item, results }: { item: Item; results: Record<string, ToolResult> }) {
  return item.kind === 'tools' ? <ToolGroup calls={item.calls} results={results} /> : <PartView part={item.part} />;
}
