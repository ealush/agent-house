// Hermes: every session (CLI, TUI, gateway) lives in one SQLite database,
// ~/.hermes/state.db ($HERMES_HOME honored). `sessions` holds one row per
// conversation (with its cwd); `messages` holds chat-completion style rows:
// role user / assistant / tool / system, `content` text, assistant
// `tool_calls` as a JSON array of { id, function: { name, arguments } }, and
// tool rows answering by `tool_call_id` with a JSON body ({"output": ...}).
// Like opencode, this is a document loader: the database is opened read-only
// per poll and never held, and a locked or missing database yields null.
//
// Format status: verified against a local Hermes install (state.db schema with
// sessions.cwd and messages.tool_calls), October 2026.
import type { Entry, Part } from '../schema.ts';
import { parseArgs, textParts, toolResult } from '../parts.ts';

export type HermesRow = {
  id: number;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  timestamp: number;
  reasoning: string | null;
  display_kind: string | null;
};

function json(text: string | null): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A tool row's body: the output text, and whether it reports a failure. */
function toolBody(content: string | null): { text: string; isError: boolean } {
  const body = json(content);
  if (!body || typeof body !== 'object') return { text: content ?? '', isError: false };
  const isError = body.success === false || typeof body.error === 'string' || (typeof body.exit_code === 'number' && body.exit_code !== 0);
  const text = typeof body.output === 'string' ? body.output : typeof body.error === 'string' ? body.error : typeof body.content === 'string' ? body.content : JSON.stringify(body, null, 2);
  return { text, isError };
}

/** User content is text, or a multimodal array of { type: 'text', text }. */
function userText(content: string | null): string {
  const parsed = json(content);
  if (Array.isArray(parsed)) return parsed.map((p) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  return content ?? '';
}

export function hermesEntries(rows: HermesRow[]): Entry[] {
  const out: Entry[] = [];
  for (const row of rows) {
    if (row.display_kind === 'hidden' || row.role === 'system') continue;
    const parts: Part[] = [];
    const at = Math.round(row.timestamp * 1000);
    if (row.role === 'user') {
      const text = userText(row.content).trim();
      if (text) parts.push(...textParts(text));
    } else if (row.role === 'assistant') {
      if (row.reasoning?.trim()) parts.push({ type: 'reasoning', text: row.reasoning.trim() });
      if (row.content?.trim()) parts.push(...textParts(row.content));
      const calls = json(row.tool_calls);
      if (Array.isArray(calls)) {
        for (const c of calls) {
          const id = String(c?.id ?? c?.call_id ?? `hermes-call-${row.id}`);
          parts.push({ type: 'tool_call', call: { id, name: String(c?.function?.name ?? 'tool'), args: parseArgs(c?.function?.arguments ?? {}) } });
        }
      }
    } else if (row.role === 'tool' && row.tool_call_id) {
      const { text, isError } = toolBody(row.content);
      parts.push(toolResult(row.tool_call_id, text, isError));
    }
    if (!parts.length) continue;
    const role = row.role === 'user' ? 'user' : row.role === 'tool' ? 'tool' : 'assistant';
    const step = parts.some((p) => p.type === 'tool_call') ? 'tool_execution' : role === 'user' ? 'message' : role === 'tool' ? 'tool_execution' : 'llm_call';
    out.push({ seq: row.id, id: String(row.id), role, step, at, parts });
  }
  return out;
}

/** Document loader registered in DOC_ADAPTERS; `source` is "<db path>#<session id>". */
export async function loadHermes(source: string): Promise<Entry[] | null> {
  const hash = source.lastIndexOf('#');
  const dbPath = source.slice(0, hash);
  const sessionId = source.slice(hash + 1);
  const { DatabaseSync } = (await import('node:sqlite')) as any;
  let db: any;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const rows = db
      .prepare('SELECT id, role, content, tool_calls, tool_call_id, timestamp, reasoning, display_kind FROM messages WHERE session_id = ? ORDER BY id')
      .all(sessionId) as HermesRow[];
    return hermesEntries(rows);
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {}
  }
}
