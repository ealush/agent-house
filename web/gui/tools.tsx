// Tool calls as objects: the dispatch router picks a view by tool name, with a
// default for everything else. A new visualization is a new entry in TOOLS; the
// server already carries name, id, args and result, so nothing else changes.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ToolCall, ToolResult } from '../../server/feed/schema.ts';
import { DiffView } from './DiffView.tsx';
import { patchLines, replaceLines, structuredLines } from './diff.ts';
import { Checklist } from './widgets.tsx';
import { CodeBlock } from './CodeBlock.tsx';
import { Markdown } from './Markdown.tsx';
import { useGui } from './context.ts';
import { useStepsHidden } from './steps.ts';

export type ToolProps = { call: ToolCall; result: ToolResult | undefined };

/** The call a permission prompt is asking about, while it waits: drawn open, marked as waiting for you. */
export const AwaitingTool = createContext<string | null>(null);
/** False once the session is neither working nor waiting: a call still without a result never got one (denied, interrupted). */
export const TurnLive = createContext(true);

type ToolView = {
  /** What the agent did, e.g. "Ran", "Edited". */
  label: string;
  /** The same while the call has no result yet (running, or waiting for you): "Run", "Edit". */
  now?: string;
  /** The one thing that identifies this call: a command, a path, a query. */
  summary: (call: ToolCall, result?: ToolResult) => string;
  /** Expanded content; defaults to the arguments and the output. */
  Body?: (p: ToolProps) => ReactNode;
  /** Expanded without a click (plans and questions are the point of the call). */
  open?: boolean;
  /** Folds once its result arrives (an answered question reads fine as one line). */
  foldWhenDone?: boolean;
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
      {result.text.trim() ? <CodeBlock className={`code-block ${result.isError ? 'error' : ''}`}>{result.text.replace(/\n+$/, '')}</CodeBlock> : <p className="muted small">{empty}</p>}
      {result.images?.map((src, i) => <img key={i} className="widget-img" src={src} alt="" />)}
    </>
  );
}

function FileLink({ path }: { path: string }) {
  const gui = useGui();
  return (
    <a className="mono file-link" href={gui.fileUrl(gui.resolvePath(path))} target="_blank" rel="noreferrer noopener" title={path}>
      {gui.displayPath(path)}
    </a>
  );
}

const Shell: ToolView = {
  label: 'Ran',
  now: 'Run',
  summary: (c) => firstLine(s(c.args.command ?? c.args.cmd ?? c.args.input)),
  Body: ({ call, result }) => {
    const cmd = s(call.args.command ?? call.args.cmd ?? call.args.input);
    return (
      <>
        {s(call.args.description) && <p className="muted small">{s(call.args.description)}</p>}
        <CodeBlock className="code-block command" text={cmd}>
          $ {cmd}
        </CodeBlock>
        <Output result={result} />
      </>
    );
  },
};

const Edit: ToolView = {
  label: 'Edited',
  now: 'Edit',
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
  now: 'Write',
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
  now: 'Patch',
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
  now: 'Search',
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
  now: 'Fetch',
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
  now: 'Update the plan',
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

/** While open, the questions are answered in the form under the feed; afterwards this shows the answers. */
const Question: ToolView = {
  label: 'Asked',
  summary: (c, r) => {
    const first = firstLine(s((c.args.questions as any[] | undefined)?.[0]?.question), 80);
    const answers = Object.values((r?.data?.answers ?? {}) as Record<string, unknown>).map(s);
    return answers.length ? `${first} → ${answers.join(' · ')}` : first;
  },
  open: true,
  foldWhenDone: true,
  Body: ({ call, result }) => {
    if (!result) return <p className="muted small">Waiting for your answer below.</p>;
    const qs = (call.args.questions as any[] | undefined) ?? [];
    const answers = (result?.data?.answers ?? {}) as Record<string, unknown>;
    return (
      <div className="questions">
        {qs.map((q, i) => (
          <div key={i} className="question">
            <strong>{s(q?.question)}</strong>
            <ul>
              {(q?.options ?? []).map((o: any, j: number) => (
                <li key={j} className={s(answers[s(q?.question)]).split(', ').includes(s(o?.label)) ? 'picked' : ''}>
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
  now: 'Delegate',
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
      {Object.keys(call.args).length > 0 && <CodeBlock className="code-block">{JSON.stringify(call.args, null, 2)}</CodeBlock>}
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
  // Grok, Gemini, Muse and opencode tool names. Anything not listed here
  // still renders through the default view; these are the common file and
  // shell tools whose arguments match the existing views.
  run_terminal_command: Shell,
  run_shell_command: Shell,
  bash: Shell,
  read_file: Read,
  read: Read,
  write_file: Write,
  write: Write,
  search_replace: Edit,
  replace: Edit,
  edit: Edit,
  grep: Search,
  grep_search: Search,
  glob: Search,
  web_fetch: Web,
  // Hermes
  terminal: Shell,
  search_files: Search,
  web_extract: { ...Web, summary: (c) => s((c.args.urls as unknown[] | undefined)?.join(', ') ?? c.args.url) },
};

/** `mcp__server__tool` → "tool (server)"; otherwise the name as given. */
function displayName(name: string) {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[2]} (${m[1]})` : name;
}

export function ToolRow({ call, result }: ToolProps) {
  const view = TOOLS[call.name] ?? Default;
  const [open, setOpen] = useState(!!view.open && !(view.foldWhenDone && result));
  const running = !result;
  const done = !!result;
  const awaiting = useContext(AwaitingTool) === call.id && running;
  const turnLive = useContext(TurnLive);
  const stopped = running && !awaiting && !turnLive;
  useEffect(() => {
    if (done && view.foldWhenDone) setOpen(false);
  }, [done, view.foldWhenDone]);
  // What it wants to do is the question: show it (an edit as its diff) without a click.
  useEffect(() => {
    if (awaiting) setOpen(true);
  }, [awaiting]);
  const status = awaiting ? 'awaiting' : stopped ? 'stopped' : running ? 'running' : result.isError ? 'error' : 'done';
  const Body = view.Body ?? Default.Body!;
  return (
    <div className={`tool ${status} ${open ? 'open' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`tool-dot ${status}`} aria-label={awaiting ? 'Waiting for you' : stopped ? 'No result' : running ? 'Running' : result.isError ? 'Failed' : 'Completed'} />
        <span className="tool-label">{(running && view.now) || view.label || displayName(call.name)}</span>
        <span className="tool-summary mono">{view.summary(call, result)}</span>
        {running && <span className="tool-state">{awaiting ? 'Waiting for you' : stopped ? 'No result' : 'Running…'}</span>}
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

/** Consecutive calls: a long run collapses to its last few, with the rest a click away.
 *  With steps hidden, the whole run is one line, unless something in it is asking you. */
export function ToolGroup({ calls, results }: { calls: ToolCall[]; results: Record<string, ToolResult> }) {
  const [all, setAll] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const stepsHidden = useStepsHidden();
  const awaiting = useContext(AwaitingTool);
  const turnLive = useContext(TurnLive);
  const asking = calls.some((c) => c.id === awaiting || (TOOLS[c.name] === Question && !results[c.id] && turnLive));
  const KEEP = 3;
  if (stepsHidden && !asking) {
    const running = turnLive && calls.some((c) => !results[c.id]);
    const failed = calls.filter((c) => results[c.id]?.isError).length;
    return (
      <div className={`tool-group ${unfolded ? 'unfolded' : 'folded'}`}>
        <button className="tool-fold" onClick={() => setUnfolded(!unfolded)} aria-expanded={unfolded}>
          {running && <span className="tool-dot running" aria-label="Running" />}
          {calls.length} step{calls.length === 1 ? '' : 's'}
          {failed > 0 && <span className="tool-fold-failed">· {failed} failed</span>}
          <span className="tool-caret" aria-hidden>
            ›
          </span>
        </button>
        {unfolded && calls.map((c) => <ToolRow key={c.id} call={c} result={results[c.id]} />)}
      </div>
    );
  }
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
