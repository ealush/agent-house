// Dispatch from typed content to components: part type → renderer here, tool name
// → web/gui/tools.tsx, widget type → web/gui/widgets.tsx. No string matching on prose.
import { useState, type ReactNode } from 'react';
import type { Part, ToolResult } from '../../server/feed/schema.ts';
import type { Item } from './reducer.ts';
import { Markdown } from './Markdown.tsx';
import { WidgetView } from './widgets.tsx';
import { ToolGroup } from './tools.tsx';
import { useGui } from './context.ts';
import { splitUploads } from '../uploads.ts';
import { Icon } from '../icons.tsx';
import { useStepsHidden } from './steps.ts';

type PartOf<T extends Part['type']> = Extract<Part, { type: T }>;
type PartRenderers = { [T in Part['type']]: (p: PartOf<T>) => ReactNode };

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  // Thinking is a step too: with steps hidden it isn't drawn at all.
  if (useStepsHidden()) return null;
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

/** Your message's text, with what you attached drawn above it instead of its paths. */
export function UserText({ text }: { text: string }) {
  const gui = useGui();
  const { uploads, rest } = splitUploads(text);
  if (!uploads.length) return <Markdown text={text} />;
  return (
    <>
      <div className="user-images">
        {uploads.map((u, i) => (
          <a key={i} className={u.image ? undefined : 'user-file'} href={gui.fileUrl(u.path)} target="_blank" rel="noreferrer noopener" title={u.path}>
            {u.image ? <img src={gui.fileUrl(u.path)} alt={u.name} loading="lazy" /> : <><Icon name="files" size={14} /> {u.name}</>}
          </a>
        ))}
      </div>
      {rest && <Markdown text={rest} />}
    </>
  );
}

export function PartView({ part }: { part: Part }) {
  return <>{(PARTS[part.type] as (p: Part) => ReactNode)(part)}</>;
}

export function ItemView({ item, results }: { item: Item; results: Record<string, ToolResult> }) {
  return item.kind === 'tools' ? <ToolGroup calls={item.calls} results={results} /> : <PartView part={item.part} />;
}
