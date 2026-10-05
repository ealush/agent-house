// Tool calls as objects: the dispatch router picks a view by tool name, with a
// default for everything else. A new visualization is a new entry in TOOLS; the
// server already carries name, id, args and result, so nothing else changes.
import { useState, type ReactNode } from 'react';
import type { ToolCall, ToolResult } from '../../server/feed/schema.ts';
import { DiffView } from './DiffView.tsx';
import { patchLines, replaceLines, structuredLines } from './diff.ts';
import { Checklist } from './widgets.tsx';
import { Markdown } from './Markdown.tsx';
import { useGui } from './context.ts';

export type ToolProps = { call: ToolCall; result: ToolResult | undefined };

type ToolView = {
  /** What the agent is doing, e.g. "Ran", "Edited". */
  label: string;
  /** The one thing that identifies this call: a command, a path, a query. */
  summary: (call: ToolCall) => string;
  /** Expanded content; defaults to the arguments and the output. */
  Body?: (p: ToolProps) => ReactNode;
  /** Expanded without a click (plans and questions are the point of the call). */
  open?: boolean;
};

const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const firstLine = (t: string, max = 120) => {
  const l = t.trim().split('\n')[0] ?? '';
  return l.length > max ? l.slice(0, max - 1) + '…' : l;
};

function Output({ result, empty = 'No output' }: { result: ToolResult | undefined; empty?: string }) {
  if (!result) return null;
  return (
    <>
      {result.text.trim() ? <pre className={`code-block ${result.isError ? 'error' : ''}`}>{result.text.replace(/\n+$/, '')}</pre> : <p className="muted small">{empty}</p>}
      {result.images?.map((src, i) => <img key={i} className="widget-img" src={src} alt="" />)}
    </>
  );
}

function FileLink({ path }: { path: string }) {
  const gui = useGui();
  return (
    <a className="mono file-link" href={gui.fileUrl(gui.resolvePath(path))} target="_blank" rel="noreferrer noopener">
      {path}
    </a>
  );
}

const Shell: ToolView = {
  label: 'Ran',
  summary: (c) => firstLine(s(c.args.command ?? c.args.cmd ?? c.args.input)),
  Body: ({ call, result }) => (
    <>
      {s(call.args.description) && <p className="muted small">{s(call.args.description)}</p>}
      <pre className="code-block command">$ {s(call.args.command ?? call.args.cmd ?? call.args.input)}</pre>
      <Output result={result} />
    </>
  ),
};

const Edit: ToolView = {
  label: 'Edited',
  summary: (c) => base(s(c.args.file_path ?? c.args.path)),
  Body: ({ call, result }) => {
    const lines = structuredLines(result?.data?.structuredPatch) ?? replaceLines(s(call.args.old_string), s(call.args.new_string));
    return (
      <>
        <FileLink path={s(call.args.file_path ?? call.args.path)} />
        <DiffView lines={lines} />
        {result?.isError && <Output result={result} />}
      </>
    );
  },
};

const Write: ToolView = {
  label: 'Wrote',
  summary: (c) => base(s(c.args.file_path ?? c.args.path)),
  Body: ({ call, result }) => {
    const patch = structuredLines(result?.data?.structuredPatch);
    return (
      <>
        <FileLink path={s(call.args.file_path ?? call.args.path)} />
        {patch ? <DiffView lines={patch} /> : <DiffView lines={replaceLines('', s(call.args.content))} />}
        {result?.isError && <Output result={result} />}
      </>
    );
  },
};

const Patch: ToolView = {
  label: 'Patched',
  summary: (c) => {
    const files = patchLines(s(c.args.input ?? c.args.patch)).filter((l) => l.kind === 'file').map((l) => base(l.text));
    return files.length ? files.join(', ') : 'files';
  },
  Body: ({ call, result }) => (
    <>
      <DiffView patch={s(call.args.input ?? call.args.patch)} />
      {result && result.isError && <Output result={result} />}
    </>
  ),
};

const Read: ToolView = {
  label: 'Read',
  summary: (c) => base(s(c.args.file_path ?? c.args.path)),
  Body: ({ call, result }) => (
    <>
      <FileLink path={s(call.args.file_path ?? call.args.path)} />
      <Output result={result} />
    </>
  ),
};

const Search: ToolView = {
  label: 'Searched',
  summary: (c) => s(c.args.pattern ?? c.args.query),
  Body: ({ call, result }) => (
    <>
      {s(call.args.path) && <p className="muted small">in {s(call.args.path)}</p>}
      <Output result={result} empty="No matches" />
    </>
  ),
};

const Web: ToolView = {
  label: 'Fetched',
  summary: (c) => s(c.args.url ?? c.args.query),
  Body: ({ call, result }) => (
    <>
      {s(call.args.url) && <Markdown text={`<${s(call.args.url)}>`} />}
      {s(call.args.prompt) && <p className="muted small">{s(call.args.prompt)}</p>}
      <Output result={result} />
    </>
  ),
};

const WebSearch: ToolView = { ...Web, label: 'Searched the web', summary: (c) => s(c.args.query) };

/** Claude's TodoWrite and Codex's update_plan are the same idea: a live checklist. */
const Todos: ToolView = {
  label: 'Updated the plan',
  summary: (c) => {
    const items = (c.args.todos ?? c.args.plan) as any[] | undefined;
    const done = items?.filter((t) => t?.status === 'completed').length ?? 0;
    return items ? `${done}/${items.length} done` : '';
  },
  open: true,
  Body: ({ call }) => {
    const items = ((call.args.todos ?? call.args.plan) as any[] | undefined) ?? [];
    return (
      <Checklist
        items={items.map((t) => ({
          text: s(t?.status === 'in_progress' ? (t.activeForm ?? t.content ?? t.step) : (t?.content ?? t?.step)),
          state: t?.status === 'completed' ? 'done' : t?.status === 'in_progress' ? 'active' : 'todo',
        }))}
      />
    );
  },
};

/** Questions are answered in the agent's own picker; the GUI shows them and the answers. */
const Question: ToolView = {
  label: 'Asked',
  summary: (c) => firstLine(s((c.args.questions as any[] | undefined)?.[0]?.question)),
  open: true,
  Body: ({ call, result }) => {
    const qs = (call.args.questions as any[] | undefined) ?? [];
    const answers = (result?.data?.answers ?? {}) as Record<string, unknown>;
    return (
      <div className="questions">
        {qs.map((q, i) => (
          <div key={i} className="question">
            <strong>{s(q?.question)}</strong>
            <ul>
              {(q?.options ?? []).map((o: any, j: number) => (
                <li key={j} className={answers[s(q?.question)] === s(o?.label) ? 'picked' : ''}>
                  {s(o?.label)}
                  {o?.description && <span className="muted"> — {s(o.description)}</span>}
                </li>
              ))}
            </ul>
            {answers[s(q?.question)] !== undefined && <p className="small">Answer: {s(answers[s(q?.question)])}</p>}
          </div>
        ))}
      </div>
    );
  },
};

const Agent: ToolView = {
  label: 'Delegated',
  summary: (c) => s(c.args.description ?? c.args.subagent_type),
  Body: ({ call, result }) => (
    <>
      {s(call.args.prompt) && <Markdown text={s(call.args.prompt)} />}
      {result && <Markdown text={result.text} />}
    </>
  ),
};

/** Anything without its own view: name, status, arguments and output. */
const Default: ToolView = {
  label: '',
  summary: (c) => {
    const first = Object.values(c.args).find((v) => typeof v === 'string');
    return firstLine(s(first ?? ''), 80);
  },
  Body: ({ call, result }) => (
    <>
      {Object.keys(call.args).length > 0 && <pre className="code-block">{JSON.stringify(call.args, null, 2)}</pre>}
      <Output result={result} />
    </>
  ),
};

export const TOOLS: Record<string, ToolView> = {
  // Claude Code
  Bash: Shell,
  Edit,
  MultiEdit: Edit,
  NotebookEdit: Edit,
  Write,
  Read,
  Grep: Search,
  Glob: Search,
  WebFetch: Web,
  WebSearch,
  TodoWrite: Todos,
  AskUserQuestion: Question,
  Task: Agent,
  Agent,
  // Codex
  shell: Shell,
  exec: Shell,
  exec_command: Shell,
  local_shell: Shell,
  apply_patch: Patch,
  update_plan: Todos,
  web_search: WebSearch,
};

/** `mcp__server__tool` → "tool (server)"; otherwise the name as given. */
function displayName(name: string) {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[2]} (${m[1]})` : name;
}

export function ToolRow({ call, result }: ToolProps) {
  const view = TOOLS[call.name] ?? Default;
  const [open, setOpen] = useState(!!view.open);
  const running = !result;
  const status = running ? 'running' : result.isError ? 'error' : 'done';
  const Body = view.Body ?? Default.Body!;
  return (
    <div className={`tool ${status} ${open ? 'open' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`tool-dot ${status}`} aria-label={running ? 'Running' : result.isError ? 'Failed' : 'Completed'} />
        <span className="tool-label">{view.label || displayName(call.name)}</span>
        <span className="tool-summary mono">{view.summary(call)}</span>
        {running && <span className="tool-state">Running…</span>}
        {result?.truncated && <span className="tool-state">trimmed</span>}
        <span className="tool-caret" aria-hidden>
          ›
        </span>
      </button>
      {open && (
        <div className="tool-body">
          <Body call={call} result={result} />
        </div>
      )}
    </div>
  );
}

/** Consecutive calls: a long run collapses to its last few, with the rest a click away. */
export function ToolGroup({ calls, results }: { calls: ToolCall[]; results: Record<string, ToolResult> }) {
  const [all, setAll] = useState(false);
  const KEEP = 3;
  const hidden = all ? 0 : Math.max(0, calls.length - KEEP);
  return (
    <div className="tool-group">
      {hidden > 0 && (
        <button className="tool-more" onClick={() => setAll(true)}>
          {hidden} earlier step{hidden === 1 ? '' : 's'}
        </button>
      )}
      {calls.slice(hidden).map((c) => (
        <ToolRow key={c.id} call={c} result={results[c.id]} />
      ))}
    </div>
  );
}
