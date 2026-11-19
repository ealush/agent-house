// Claude Code's subagents, as it writes them (2.1.x, verified on real sessions):
//   <projects>/<cwd>/<session>/subagents/agent-<agentId>.jsonl   the child's transcript
//   <projects>/<cwd>/<session>/subagents/agent-<agentId>.meta.json
//     {agentType, description, toolUseId, parentAgentId?, spawnDepth, requestShape}
// Nested children sit flat in the same folder, naming their parent agent. A child's
// outcome is in its parent's transcript (the root's, or `agent-<parent>.jsonl`): the
// spawning call's tool_result (inline for a foreground child, an acknowledgement for a
// background one), and for a background child a <task-notification> naming its id.
// Pure parsing: the reads are in store.ts.
import { isAgentId, line, type ClaudeOutcome, type TailFacts } from './model.ts';

export type ClaudeMeta = {
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  parentAgentId: string | null;
  depth: number;
  background: boolean;
};

const TOOL_ID = /^[\w-]{1,80}$/;

/** The sidecar, validated field by field: anything odd is dropped, never trusted as a path. */
export function parseMeta(text: string): ClaudeMeta | null {
  let d: any;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const tool = str(d.toolUseId);
  const parent = str(d.parentAgentId);
  return {
    agentType: str(d.agentType)?.slice(0, 80) ?? null,
    description: line(d.description, 120),
    toolUseId: tool && TOOL_ID.test(tool) ? tool : null,
    parentAgentId: parent && isAgentId(parent) ? parent : null,
    depth: Number.isInteger(d.spawnDepth) && d.spawnDepth > 0 ? d.spawnDepth : 1,
    background: d.requestShape === 'background',
  };
}

const seconds = (ts: unknown) => {
  const t = typeof ts === 'string' ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
};

const NOTE = /<task-notification>[\s\S]*?<\/task-notification>/g;
const TAG = (name: string) => new RegExp(`<${name}>([^<]{1,200})</${name}>`);

/**
 * What one parent transcript line says about the children it spawned: results of the
 * calls in `calls` (tool_use ids), and task notifications. Lines that can't be either
 * are skipped by a substring test, without parsing.
 */
export function outcomesOf(text: string, calls: ReadonlySet<string>): { toolUseId?: string; agentId?: string; outcome: ClaudeOutcome }[] {
  const out: { toolUseId?: string; agentId?: string; outcome: ClaudeOutcome }[] = [];
  const hasResult = text.includes('"tool_use_id"');
  const hasNote = text.includes('<task-notification>');
  if (!hasResult && !hasNote) return out;
  let d: any;
  try {
    d = JSON.parse(text);
  } catch {
    return out;
  }
  if (!d || typeof d !== 'object') return out;
  const at = seconds(d.timestamp);
  if (hasResult && d.type === 'user' && Array.isArray(d.message?.content)) {
    for (const c of d.message.content) {
      if (c?.type !== 'tool_result' || typeof c.tool_use_id !== 'string') continue;
      const r = d.toolUseResult && typeof d.toolUseResult === 'object' ? d.toolUseResult : null;
      // A call of a child known by its sidecar, or any call whose result names an agent
      // (the result can be read before the sidecar of the child it names).
      if (!calls.has(c.tool_use_id) && typeof r?.agentId !== 'string') continue;
      const said = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n') : '';
      out.push({
        toolUseId: c.tool_use_id,
        outcome: {
          kind: 'result',
          status: typeof r?.status === 'string' ? r.status : null,
          isError: c.is_error === true,
          interrupted: /^\[Request interrupted by user/.test(said.trim()) || r?.status === 'interrupted',
          at,
        },
      });
    }
  }
  if (hasNote) {
    // Only where the harness puts its notifications: what a tool printed or a person pasted can quote one.
    const where =
      d.type === 'queue-operation' && d.operation === 'enqueue' && typeof d.content === 'string'
        ? d.content
        : d.type === 'attachment' && d.attachment?.type === 'queued_command' && (d.attachment.commandMode === 'task-notification' || d.attachment.origin?.kind === 'task-notification')
          ? String(d.attachment.prompt ?? '')
          : d.type === 'user' && typeof d.message?.content === 'string' && d.message.content.trimStart().startsWith('<task-notification>')
            ? d.message.content
            : '';
    for (const m of where.match(NOTE) ?? []) {
      const id = TAG('task-id').exec(m)?.[1]?.trim();
      const status = TAG('status').exec(m)?.[1]?.trim();
      if (id && status && isAgentId(id)) out.push({ agentId: id, outcome: { kind: 'notification', status, at } });
    }
  }
  return out;
}

/** The start of the instructions a child was given: its first user line. */
export function firstPrompt(lines: string[]): string | null {
  for (const text of lines) {
    if (!text.includes('"user"')) continue;
    let d: any;
    try {
      d = JSON.parse(text);
    } catch {
      continue;
    }
    if (d?.type !== 'user') continue;
    const c = d.message?.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.find((p: any) => p?.type === 'text')?.text : null;
    const said = line(t, 300);
    if (said) return said;
  }
  return null;
}

/** One line for a tool call: its name and what it was given. */
export function describeTool(name: string, input: any): string {
  const file = [input?.file_path, input?.path, input?.notebook_path].find((v) => typeof v === 'string' && v.trim());
  const arg = [input?.description, input?.command, file && shortPath(file), input?.pattern, input?.url, input?.query, input?.prompt].find((v) => typeof v === 'string' && v.trim());
  return line(arg ? `${name}: ${arg}` : name, 120)!;
}

/** A path's last few parts: where in the project, without the machine's own folders. */
function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join('/') : path;
}

/** Tools a child calls to talk to the harness rather than to work. */
const PLUMBING = new Set(['SubagentHandback', 'SendMessage', 'TaskOutput']);

/** What the end of a child's transcript says: when it last wrote, and whether it's done. */
export function tailFacts(lines: string[]): TailFacts | null {
  let lastAt = 0;
  let activity: string | null = null;
  let lastTurn: any = null;
  for (const text of lines) {
    let d: any;
    try {
      d = JSON.parse(text);
    } catch {
      continue;
    }
    if (!d || typeof d !== 'object') continue;
    lastAt = Math.max(lastAt, seconds(d.timestamp));
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    lastTurn = d;
    if (d.type === 'assistant') {
      for (const c of Array.isArray(d.message?.content) ? d.message.content : []) {
        // Handing its report back is how it ends, not something it did.
        if (c?.type === 'tool_use' && !PLUMBING.has(String(c.name))) activity = describeTool(String(c.name ?? 'tool'), c.input);
        else if (c?.type === 'text' && line(c.text)) activity = line(c.text);
      }
    }
  }
  if (!lastAt && !lastTurn) return null;
  const content = Array.isArray(lastTurn?.message?.content) ? lastTurn.message.content : [];
  const said = typeof lastTurn?.message?.content === 'string' ? lastTurn.message.content : content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('');
  return {
    lastAt,
    final: lastTurn?.type === 'assistant' && !lastTurn.isApiErrorMessage && !content.some((c: any) => c?.type === 'tool_use') && content.some((c: any) => c?.type === 'text'),
    error: lastTurn?.type === 'assistant' && lastTurn.isApiErrorMessage === true,
    interrupted: lastTurn?.type === 'user' && /^\[Request interrupted by user/.test(String(said).trim()),
    activity,
  };
}
