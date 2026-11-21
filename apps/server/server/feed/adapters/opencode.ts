// opencode: two storage generations, both read as whole documents rather than
// line streams, so this adapter is a document loader for the feed's
// DocumentFeed (server/feed/feed.ts), not a line parser.
//
// Current (v1.2+): one SQLite database at ~/.local/share/opencode/opencode.db
// (XDG_DATA_HOME honored). Tables session / message / part; `message.data` and
// `part.data` are JSON blobs holding the record minus its ids. A session's
// transcript source is written "<db path>#<session id>" by discovery. The
// database is opened strictly read-only through node:sqlite and is never held
// open between polls; a locked or missing database yields null (no entries),
// which the stream reports as no transcript rather than an error.
//
// Legacy (pre-1.2): a JSON tree at ~/.local/share/opencode/storage/ with
// session/<projectID>/<session id>.json, message/<session id>/<message>.json
// and part/<message id>/<part>.json (a later variant nests parts under
// part/<session id>/<message id>/). The transcript source is the session info
// file itself.
//
// Part vocabulary (both generations): text, reasoning, tool (callID, tool
// name, state { status, input, output, error }), step-start, step-finish,
// snapshot, patch, agent, subtask, retry, compaction, file. Only text,
// reasoning, tool and compaction map onto the feed vocabulary; the rest carry
// nothing the GUI renders. Times prefer data.time.created over the row's
// time_created, which migration-copied rows set to the migration time.
//
// Format status: documented from third-party readers of real installs and the
// open-source storage code, NOT verified against a local opencode install.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Entry, Part } from '../schema.ts';
import { ms, parseArgs, textParts, toolResult } from '../parts.ts';

type RawMessage = { id: string; role: string; at: number; parts: any[] };

/** Normalized messages (either generation) to feed entries, seq by position. */
export function opencodeEntries(messages: RawMessage[]): Entry[] {
  const out: Entry[] = [];
  messages.forEach((m, i) => {
    const seq = i + 1;
    const parts: Part[] = [];
    for (const p of m.parts) {
      if (!p || typeof p !== 'object') continue;
      switch (p.type) {
        case 'text':
          if (!p.synthetic && typeof p.text === 'string' && p.text.trim()) parts.push(...textParts(p.text));
          break;
        case 'reasoning':
          if (typeof p.text === 'string' && p.text.trim()) parts.push({ type: 'reasoning', text: p.text.trim() });
          break;
        case 'tool': {
          const state = p.state ?? {};
          const callId = typeof p.callID === 'string' ? p.callID : typeof p.id === 'string' ? p.id : `opencode-call-${seq}`;
          parts.push({ type: 'tool_call', call: { id: callId, name: String(p.tool ?? 'tool'), args: parseArgs(state.input ?? {}) } });
          if (state.status === 'completed') parts.push(toolResult(callId, typeof state.output === 'string' ? state.output : '', false));
          else if (state.status === 'error') parts.push(toolResult(callId, typeof state.error === 'string' ? state.error : typeof state.output === 'string' ? state.output : '', true));
          break;
        }
        case 'compaction':
          parts.push({ type: 'notice', kind: 'compacted', text: 'Conversation compacted' });
          break;
      }
    }
    if (!parts.length) return;
    const role = m.role === 'user' ? 'user' : 'assistant';
    const step = parts.some((p) => p.type === 'tool_call') ? 'tool_execution' : role === 'user' ? 'message' : 'llm_call';
    out.push({ seq, id: m.id, role, step, at: m.at, parts });
  });
  return out;
}

function json(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function loadFromDb(source: string): Promise<Entry[] | null> {
  const hash = source.indexOf('#');
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
    const msgRows = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(sessionId);
    const partStmt = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id');
    const messages: RawMessage[] = [];
    for (const row of msgRows) {
      const data = json(String(row.data)) ?? {};
      const parts = partStmt.all(String(row.id)).map((r: any) => json(String(r.data))).filter(Boolean);
      messages.push({
        id: String(row.id),
        role: typeof data.role === 'string' ? data.role : 'assistant',
        at: ms(data.time?.created ?? row.time_created),
        parts,
      });
    }
    messages.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    return opencodeEntries(messages);
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

async function readJsonDir(dir: string): Promise<any[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort();
  const out: any[] = [];
  for (const name of names) {
    const value = json(await readFile(join(dir, name), 'utf8').catch(() => ''));
    if (value) out.push(value);
  }
  return out;
}

async function loadFromTree(sessionFile: string): Promise<Entry[] | null> {
  const info = json(await readFile(sessionFile, 'utf8').catch(() => ''));
  const sessionId = typeof info?.id === 'string' ? info.id : null;
  if (!sessionId) return null;
  const storage = dirname(dirname(dirname(sessionFile)));
  const rawMessages = await readJsonDir(join(storage, 'message', sessionId));
  const messages: RawMessage[] = [];
  for (const data of rawMessages) {
    if (typeof data?.id !== 'string') continue;
    let parts = await readJsonDir(join(storage, 'part', data.id));
    if (!parts.length) parts = await readJsonDir(join(storage, 'part', sessionId, data.id));
    messages.push({
      id: data.id,
      role: typeof data.role === 'string' ? data.role : 'assistant',
      at: ms(data.time?.created),
      parts,
    });
  }
  messages.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return opencodeEntries(messages);
}

/** Document loader registered in DOC_ADAPTERS. Null means no transcript yet. */
export async function loadOpencode(source: string): Promise<Entry[] | null> {
  if (source.includes('.db#')) return loadFromDb(source);
  return loadFromTree(source);
}
