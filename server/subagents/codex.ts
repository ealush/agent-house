// Codex's spawned threads (0.160–0.162, verified on real rollouts): each is a rollout of
// its own whose session_meta names its parent thread and the tree's root (read by
// discovery, `Transcript.spawned`). Its turns start and end in it: `event_msg`
// task_started, then task_complete or turn_aborted (or an error). Pure parsing.
import { describeTool } from './claude.ts';
import { line, type CodexTurn, type TailFacts } from './model.ts';

const seconds = (ts: unknown) => {
  const t = typeof ts === 'string' ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
};

const TURN: Record<string, CodexTurn['kind']> = { task_started: 'started', task_complete: 'complete', turn_aborted: 'aborted', error: 'error' };

/** The newest turn event and what the thread did last, from the end of its rollout. */
export function codexTail(lines: string[]): { last: CodexTurn | null; tail: TailFacts | null } {
  let last: CodexTurn | null = null;
  let lastAt = 0;
  let activity: string | null = null;
  for (const text of lines) {
    // Rollout lines can be large (a whole system prompt); only the few kinds read here are parsed.
    const head = text.slice(0, 160);
    if (!head.includes('"event_msg"') && !head.includes('"response_item"')) continue;
    let d: any;
    try {
      d = JSON.parse(text);
    } catch {
      continue;
    }
    const p = d?.payload;
    if (!p || typeof p !== 'object') continue;
    const at = seconds(d.timestamp);
    lastAt = Math.max(lastAt, at);
    if (d.type === 'event_msg' && TURN[p.type]) {
      last = { kind: TURN[p.type], at };
      if (p.type === 'task_complete' && line(p.last_agent_message)) activity = line(p.last_agent_message);
    } else if (d.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        let args: any = {};
        try {
          args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : {};
        } catch {}
        if (Array.isArray(args.command)) args.command = args.command.join(' ');
        if (Array.isArray(p.action?.command)) args.command = p.action.command.join(' ');
        activity = describeTool(String(p.name ?? 'shell'), args);
      } else if (p.type === 'message' && p.role === 'assistant') {
        const said = (Array.isArray(p.content) ? p.content : []).map((c: any) => (c?.type === 'output_text' ? c.text : '')).join(' ');
        if (line(said)) activity = line(said);
      }
    }
  }
  if (!lastAt) return { last, tail: null };
  return { last, tail: { lastAt, final: last?.kind === 'complete', error: last?.kind === 'error', interrupted: last?.kind === 'aborted', activity } };
}
