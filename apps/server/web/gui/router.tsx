// Dispatch from typed content to components: part type → renderer here, tool name
// → web/gui/tools.tsx, widget type → web/gui/widgets.tsx. No string matching on prose.
import { useState, type ReactNode } from 'react';
import type { Part, ToolResult } from '../../server/feed/schema.ts';
import type { Item } from './reducer.ts';
import { Markdown } from './Markdown.tsx';
import { WidgetView } from './widgets.tsx';
import { ToolGroup } from './tools.tsx';
import { useGui } from './context.ts';
import { namePictures, placeUploads } from '../uploads.ts';
import { Icon } from '../icons.tsx';
import { useStepsHidden } from './steps.ts';
import { Pictures, type Picture } from './Gallery.tsx';

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
  media: (p) => <Pictures pictures={[{ src: p.src, name: p.alt || 'Picture' }]} natural />,
  widget: (p) => <WidgetView widget={p.widget} />,
  notice: (p) => <div className={`notice ${p.kind}`}>{p.text}</div>,
  // Folded into their call by the reducer; never shown on their own.
  tool_result: () => null,
  tool_call: () => null,
};


/**
 * Your message: what you attached drawn above your words (with the pictures it carries as
 * parts of their own, so they all open together), and each attachment as a chip where you put it.
 */
export function UserParts({ parts }: { parts: Part[] }) {
  // Pasted into the agent's terminal, a picture has no name: it goes by its place.
  const media = parts.flatMap((p) => (p.type === 'media' ? [p] : [])).map((p, i, all) => ({ src: p.src, name: p.alt || (all.length > 1 ? `Picture ${i + 1}` : 'Picture') }));
  const texts = parts.flatMap((p) => (p.type === 'text' ? [p.text] : []));
  const rest = parts.filter((p) => p.type !== 'text' && p.type !== 'media');
  return (
    <>
      {texts.length ? texts.map((t, i) => <UserText key={i} text={t} pictures={i === 0 ? media : []} />) : <UserText text="" pictures={media} />}
      {rest.map((p, i) => <PartView key={i} part={p} />)}
    </>
  );
}

/**
 * Your message's text, with what you attached drawn above it, and as a chip where you put it:
 * a picture the agent took out of your words ("[Image #1]") too, which opens it.
 */
export function UserText({ text, pictures = [] }: { text: string; pictures?: Picture[] }) {
  const gui = useGui();
  const [open, setOpen] = useState<number | null>(null);
  const named = namePictures(text, pictures.length);
  const { uploads, text: placed } = placeUploads(named.text, new Set(named.tokens));
  if (!uploads.length && !pictures.length) return <Markdown text={text} />;
  const uploaded = uploads.filter((u) => u.image).map((u) => ({ src: gui.fileUrl(u.path), name: u.name }));
  const images = [...uploaded, ...pictures];
  const files = uploads.filter((u) => !u.image);
  // Each picture's chip: its place among the pictures, after the uploaded ones.
  const shots = new Map(named.tokens.map((t, k) => [t, uploaded.length + k]));
  const tokens = new Set([...uploads.map((u) => `@${u.token}`), ...named.tokens.map((t) => `@${t}`)]);
  // Only the files (a picture sent alone): the tiles say it all.
  const rest = placed.replace(/(?<=^|\s)@\S+/g, (t) => (tokens.has(t) ? '' : t)).trim() ? placed : '';
  return (
    <>
      <div className="user-images">
        <Pictures pictures={images} open={open} onOpen={setOpen} />
        {files.map((u, i) => (
          <a key={i} className="user-file" href={gui.fileUrl(u.path)} target="_blank" rel="noreferrer noopener" title={u.path}>
            <Icon name="files" size={14} /> {u.name}
          </a>
        ))}
      </div>
      {rest && <Markdown text={rest} uploads={new Map(uploads.map((u) => [u.token, u.path]))} pictures={shots} onPicture={setOpen} />}
    </>
  );
}

export function PartView({ part }: { part: Part }) {
  return <>{(PARTS[part.type] as (p: Part) => ReactNode)(part)}</>;
}

export function ItemView({ item, results }: { item: Item; results: Record<string, ToolResult> }) {
  return item.kind === 'tools' ? <ToolGroup calls={item.calls} results={results} /> : <PartView part={item.part} />;
}
