// Generative UI: the widgets an agent can ask for with a fenced ```ah-widget block
// (vocabulary in docs/gui.md). Adding a widget is adding an entry to WIDGETS; the
// server and the data layer don't change. Unknown types render generically.
import { useState, type ReactNode } from 'react';
import type { Widget } from '../../server/feed/schema.ts';
import { Markdown } from './Markdown.tsx';
import { useGui } from './context.ts';
import { DiffView } from './DiffView.tsx';

type W = Widget & Record<string, any>;
type Renderer = (props: { w: W }) => ReactNode;

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const TONES = new Set(['info', 'success', 'warning', 'danger']);
const tone = (v: unknown) => (TONES.has(v as string) ? (v as string) : 'info');

/** A button that answers the agent. `reply` is what gets sent; the label is what you see. */
function ReplyButton({ label, reply, primary }: { label: string; reply?: string; primary?: boolean }) {
  const gui = useGui();
  const [sent, setSent] = useState(false);
  return (
    <button
      className={`btn small ${primary ? 'primary' : ''}`}
      disabled={sent}
      onClick={() => {
        setSent(true);
        gui.reply(reply || label);
      }}
    >
      {label}
    </button>
  );
}

function Frame({ title, kind, children }: { title?: string; kind: string; children: ReactNode }) {
  return (
    <section className={`widget widget-${kind}`}>
      {title && <h4 className="widget-title">{title}</h4>}
      {children}
    </section>
  );
}

const Card: Renderer = ({ w }) => (
  <section className={`widget widget-card tone-${tone(w.tone)}`}>
    {w.title && <h4 className="widget-title">{str(w.title)}</h4>}
    {w.body && <Markdown text={str(w.body)} />}
    {arr(w.actions).length > 0 && (
      <div className="widget-actions">
        {arr(w.actions).map((a, i) => (
          <ReplyButton key={i} label={str(a?.label) || `Option ${i + 1}`} reply={str(a?.reply)} primary={i === 0} />
        ))}
      </div>
    )}
  </section>
);

const Choices: Renderer = ({ w }) => (
  <Frame kind="choices" title={str(w.prompt ?? w.title)}>
    <div className="widget-choices">
      {arr(w.options).map((o, i) => {
        const label = typeof o === 'string' ? o : str(o?.label);
        return (
          <div key={i} className="widget-choice">
            <ReplyButton label={label || `Option ${i + 1}`} reply={typeof o === 'string' ? o : str(o?.reply)} />
            {o?.description && <span className="muted">{str(o.description)}</span>}
          </div>
        );
      })}
    </div>
  </Frame>
);

const Table: Renderer = ({ w }) => {
  const columns = arr(w.columns).map(str);
  const rows = arr(w.rows).map((r) => (Array.isArray(r) ? r : columns.map((c) => r?.[c])));
  return (
    <Frame kind="table" title={str(w.title)}>
      <div className="md-table">
        <table>
          {columns.length > 0 && (
            <thead>
              <tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
            </thead>
          )}
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{r.map((c: unknown, j: number) => <td key={j}>{str(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  );
};

export function Checklist({ title, items }: { title?: string; items: Array<{ text: string; state: 'done' | 'active' | 'todo' }> }) {
  return (
    <Frame kind="checklist" title={title}>
      <ul className="checklist">
        {items.map((it, i) => (
          <li key={i} className={it.state}>
            <span className="check" aria-label={it.state === 'done' ? 'Done' : it.state === 'active' ? 'In progress' : 'To do'} />
            {it.text}
          </li>
        ))}
      </ul>
    </Frame>
  );
}

const ChecklistWidget: Renderer = ({ w }) => (
  <Checklist
    title={str(w.title)}
    items={arr(w.items).map((it) => ({
      text: typeof it === 'string' ? it : str(it?.text),
      state: it?.done === true || it?.status === 'done' ? 'done' : it?.done === 'in_progress' || it?.status === 'in_progress' ? 'active' : 'todo',
    }))}
  />
);

const Stats: Renderer = ({ w }) => (
  <Frame kind="stats" title={str(w.title)}>
    <div className="stats">
      {arr(w.items).map((s, i) => (
        <div key={i} className="stat">
          <span className="stat-label">{str(s?.label)}</span>
          <span className="stat-value">{str(s?.value)}</span>
          {s?.delta !== undefined && <span className={`stat-delta tone-${tone(s?.tone)}`}>{str(s.delta)}</span>}
        </div>
      ))}
    </div>
  </Frame>
);

/** One series, horizontal bars from a shared baseline; values at the tips, a table on demand. */
const BarChart: Renderer = ({ w }) => {
  const [asTable, setAsTable] = useState(false);
  const data = arr(w.data)
    .map((d) => ({ label: str(d?.label), value: Number(d?.value) }))
    .filter((d) => Number.isFinite(d.value));
  const max = Math.max(0, ...data.map((d) => d.value)) || 1;
  const unit = str(w.unit);
  const fmt = (v: number) => `${v.toLocaleString()}${unit ? ` ${unit}` : ''}`;
  return (
    <Frame kind="chart" title={str(w.title)}>
      <button className="btn ghost small widget-toggle" onClick={() => setAsTable(!asTable)}>
        {asTable ? 'Chart' : 'Table'}
      </button>
      {asTable ? (
        <Table w={{ type: 'table', columns: ['', unit || 'Value'], rows: data.map((d) => [d.label, d.value.toLocaleString()]) }} />
      ) : (
        <div className="bars" role="img" aria-label={`${str(w.title) || 'Bar chart'}: ${data.map((d) => `${d.label} ${fmt(d.value)}`).join(', ')}`}>
          {data.map((d, i) => (
            <div key={i} className="bar-row" title={`${d.label}: ${fmt(d.value)}`}>
              <span className="bar-label">{d.label}</span>
              <span className="bar-track">
                <span className="bar" style={{ width: `${Math.max(0, (d.value / max) * 100)}%` }} />
                <span className="bar-value">{fmt(d.value)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
};

const Progress: Renderer = ({ w }) => {
  const max = Number(w.max) || 100;
  const value = Math.min(max, Math.max(0, Number(w.value) || 0));
  return (
    <Frame kind="progress" title={str(w.label ?? w.title)}>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <span style={{ width: `${(value / max) * 100}%` }} />
      </div>
      <span className="muted">
        {value} / {max}
      </span>
    </Frame>
  );
};

const Links: Renderer = ({ w }) => (
  <Frame kind="links" title={str(w.title)}>
    <ul className="links">
      {arr(w.items).map((l, i) => (
        <li key={i}>
          <Markdown text={`[${str(l?.label) || str(l?.url)}](${str(l?.url)})${l?.description ? ` — ${str(l.description)}` : ''}`} />
        </li>
      ))}
    </ul>
  </Frame>
);

const Image: Renderer = ({ w }) => {
  const gui = useGui();
  const src = str(w.src);
  // Only inline images or files on the host: the page's CSP blocks other origins anyway.
  const url = src.startsWith('data:image/') ? src : src.startsWith('/') || src.startsWith('~') ? gui.fileUrl(gui.resolvePath(src)) : '';
  return (
    <Frame kind="image" title={str(w.title)}>
      {url ? <img className="widget-img" src={url} alt={str(w.alt)} /> : <span className="muted">Image not available: {src}</span>}
      {w.caption && <p className="muted">{str(w.caption)}</p>}
    </Frame>
  );
};

const Code: Renderer = ({ w }) => (
  <Frame kind="code" title={str(w.title)}>
    <pre className="code-block">
      <code>{str(w.code)}</code>
    </pre>
  </Frame>
);

const Diff: Renderer = ({ w }) => (
  <Frame kind="diff" title={str(w.title ?? w.path)}>
    <DiffView patch={str(w.patch)} />
  </Frame>
);

/** Kept as data, never guessed at: shows the type and its fields. */
const Unknown: Renderer = ({ w }) => (
  <Frame kind="unknown" title={str(w.title) || w.type}>
    <pre className="code-block">
      <code>{JSON.stringify(w, null, 2)}</code>
    </pre>
  </Frame>
);

export const WIDGETS: Record<string, Renderer> = {
  card: Card,
  choices: Choices,
  table: Table,
  checklist: ChecklistWidget,
  stats: Stats,
  'bar-chart': BarChart,
  progress: Progress,
  links: Links,
  image: Image,
  code: Code,
  diff: Diff,
};

export function WidgetView({ widget }: { widget: Widget }) {
  const R = WIDGETS[widget.type] ?? Unknown;
  return <R w={widget as W} />;
}
