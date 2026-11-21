// Antigravity CLI (agy): one SQLite database per conversation at
// ~/.gemini/antigravity-cli/conversations/<conversation id>.db. Its `steps`
// table holds the conversation, one row per step (`idx` from 0), and each
// row's `step_payload` is a protobuf `exa.cortex_pb.Step`. Steps are rewritten
// in place as they run (a tool step goes RUNNING → DONE, a reply streams in),
// so this is a document loader for the feed's DocumentFeed, not a line parser.
//
// The field numbers below come from the schema agy ships inside its own binary
// (third_party/jetski/cortex_pb/cortex.proto, read from agy 1.5.14) and were
// checked against real conversations; the fixture in server/fixtures/agy is one,
// trimmed to these fields. Nothing here decodes more than it renders:
//
//   Step                      1 type, 4 status, 5 metadata, 19 user_input,
//                             20 planner_response, 140 generic (a tool's run)
//   CortexStepMetadata        1 created_at (Timestamp: 1 seconds, 2 nanos),
//                             4 tool_call (ChatToolCall: 1 id, 2 name, 3 arguments_json)
//   CortexStepUserInput       1 query, 2 user_response, 3 items (TextOrScopeItem: 1 text)
//   CortexStepPlannerResponse 1 response, 3 thinking, 7 tool_calls, 8 modified_response
//   CortexStepGeneric         2 result (GenericStepResult: 1 result,
//                             3 step_render_info → 10 content_blocks → 3 terminal → 3 exit_code)
//
// The database is opened read-only and never held between polls; agy writes
// through a WAL, which a read-only reader still sees. A locked, missing or
// half-written database yields null (no entries yet).
import { stat } from 'node:fs/promises';
import type { Entry, Part } from '../schema.ts';
import { parseArgs, textParts, toolResult } from '../parts.ts';

// ---------- a protobuf reader: just enough of the wire format to walk messages

type Field = { n: number; wire: number; int: number; bytes: Uint8Array | null };

const utf8 = new TextDecoder();

function varint(b: Uint8Array, at: { i: number }): number {
  let out = 0;
  let mul = 1;
  for (let k = 0; k < 10; k++) {
    if (at.i >= b.length) throw new RangeError('truncated varint');
    const c = b[at.i++];
    out += (c & 0x7f) * mul;
    if (c < 0x80) return out;
    mul *= 128;
  }
  throw new RangeError('varint too long');
}

/** A message's fields in order; a malformed tail ends the list instead of throwing. */
export function fields(b: Uint8Array | null | undefined): Field[] {
  const out: Field[] = [];
  if (!b) return out;
  const at = { i: 0 };
  try {
    while (at.i < b.length) {
      const tag = varint(b, at);
      const n = Math.floor(tag / 8);
      const wire = tag & 7;
      if (wire === 0) out.push({ n, wire, int: varint(b, at), bytes: null });
      else if (wire === 2) {
        const len = varint(b, at);
        if (at.i + len > b.length) break;
        out.push({ n, wire, int: 0, bytes: b.subarray(at.i, at.i + len) });
        at.i += len;
      } else if (wire === 1) at.i += 8;
      else if (wire === 5) at.i += 4;
      else break;
    }
  } catch {}
  return out;
}

const msg = (b: Uint8Array | null | undefined, n: number) => fields(b).find((f) => f.n === n && f.bytes)?.bytes ?? null;
const msgs = (b: Uint8Array | null | undefined, n: number) => fields(b).flatMap((f) => (f.n === n && f.bytes ? [f.bytes] : []));
const str = (b: Uint8Array | null | undefined, n: number) => {
  const v = msg(b, n);
  return v ? utf8.decode(v) : '';
};
const int = (b: Uint8Array | null | undefined, n: number) => fields(b).find((f) => f.n === n && f.wire === 0)?.int ?? 0;

// ---------- steps

/** CortexStepType values this reader renders. */
export const STEP = { userInput: 14, plannerResponse: 15, systemMessage: 101 } as const;
/** CortexStepStatus values. */
const STATUS = { error: 7, canceled: 6, interrupted: 12 } as const;

/** Timestamp → ms. */
function time(b: Uint8Array | null): number {
  return b ? int(b, 1) * 1000 + Math.floor(int(b, 2) / 1e6) : 0;
}

/**
 * agy names its tools' arguments in PascalCase ("CommandLine", "Path", "Target").
 * The clients' tool views read the common names (command, file_path, old_string),
 * so those are added beside agy's own, never over an argument already there.
 */
const ALIASES: Record<string, string[]> = {
  CommandLine: ['command'],
  Path: ['file_path', 'path'],
  AbsolutePath: ['file_path', 'path'],
  TargetFile: ['file_path', 'path'],
  DirectoryPath: ['path'],
  SearchPath: ['path'],
  Content: ['content'],
  CodeContent: ['content'],
  Target: ['old_string'],
  TargetContent: ['old_string'],
  Replacement: ['new_string'],
  ReplacementContent: ['new_string'],
  Query: ['query', 'pattern'],
  Url: ['url'],
  toolSummary: ['description'],
};

export function agyArgs(json: string): Record<string, unknown> {
  const args = parseArgs(json);
  for (const [from, to] of Object.entries(ALIASES)) {
    if (args[from] === undefined) continue;
    for (const key of to) if (args[key] === undefined) args[key] = args[from];
  }
  return args;
}

function toolCall(b: Uint8Array): Part | null {
  const id = str(b, 1);
  const name = str(b, 2);
  if (!id || !name) return null;
  return { type: 'tool_call', call: { id, name, args: agyArgs(str(b, 3)) } };
}

/** "Created At: …\nCompleted At: …\n" heads every tool result agy writes; the rest is what the tool said. */
function resultText(raw: string): string {
  return raw.replace(/^(?:(?:Created|Completed) At: [^\n]*\n)+/, '').trim();
}

/** A command's exit code, from the result's terminal block; null for any other tool. */
function exitCode(result: Uint8Array | null): number | null {
  for (const block of msgs(msg(result, 3), 10)) {
    const terminal = msg(block, 3);
    if (terminal) return int(terminal, 3);
  }
  return null;
}

/** One step → one entry (seq = idx + 1), or null for a step that renders nothing. */
export function agyEntry(idx: number, type: number, status: number, payload: Uint8Array): Entry | null {
  const seq = idx + 1;
  const meta = msg(payload, 5);
  const at = time(msg(meta, 1));
  const entry = (role: Entry['role'], step: Entry['step'], parts: Part[]): Entry | null => (parts.length ? { seq, id: String(seq), role, step, at, parts } : null);
  const stopped = status === STATUS.canceled || status === STATUS.interrupted;

  if (type === STEP.userInput) {
    const input = msg(payload, 19);
    const items = msgs(input, 3)
      .map((item) => str(item, 1))
      .join('');
    const text = (items || str(input, 2) || str(input, 1)).trim();
    return entry('user', 'message', text ? [{ type: 'text', text }] : []);
  }

  if (type === STEP.plannerResponse) {
    const reply = msg(payload, 20);
    const parts: Part[] = [];
    const thinking = str(reply, 3).trim();
    if (thinking) parts.push({ type: 'reasoning', text: thinking });
    const text = str(reply, 8) || str(reply, 1);
    if (text.trim()) parts.push(...textParts(text));
    for (const call of msgs(reply, 7)) {
      const part = toolCall(call);
      if (part) parts.push(part);
    }
    if (stopped) parts.push({ type: 'notice', kind: 'interrupted', text: 'Interrupted' });
    return entry('assistant', parts.some((p) => p.type === 'tool_call') ? 'tool_execution' : 'llm_call', parts);
  }

  // A tool's run: any step that answers a call the model made.
  const call = msg(meta, 4);
  const callId = str(call, 1);
  if (callId && type !== STEP.systemMessage) {
    const result = msg(msg(payload, 140), 2);
    const text = resultText(str(result, 1));
    const code = exitCode(result);
    // Still running (or waiting for you): no result yet, so the call shows as live.
    if (!result && !stopped && status !== STATUS.error) return null;
    const isError = status === STATUS.error || stopped || (code !== null && code !== 0);
    return entry('tool', 'observation', [toolResult(callId, text || (stopped ? 'Cancelled' : ''), isError, code !== null ? { data: { exitCode: code } } : {})]);
  }
  // System reminders agy feeds its model, checkpoints and the like: not the conversation.
  return null;
}

// ---------- the database

type Row = { idx: number; step_type: number; status: number; step_payload: Uint8Array | null };

/** Every step's entry, in order. Exported for tests that build a database from the fixture. */
export function agyEntries(rows: Row[]): Entry[] {
  const out: Entry[] = [];
  for (const r of rows) {
    if (!r.step_payload) continue;
    const e = agyEntry(Number(r.idx), Number(r.step_type), Number(r.status), r.step_payload);
    if (e) out.push(e);
  }
  return out;
}

// A poll reads the whole conversation; between writes the answer is the same.
const memo = new Map<string, { sig: string; entries: Entry[] }>();

async function signature(file: string): Promise<string | null> {
  const [db, wal] = await Promise.all([stat(file).catch(() => null), stat(`${file}-wal`).catch(() => null)]);
  if (!db) return null;
  return `${db.mtimeMs}:${db.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`;
}

/** Document loader registered in DOC_ADAPTERS. Null means no transcript (yet). */
export async function loadAgy(file: string): Promise<Entry[] | null> {
  const sig = await signature(file);
  if (!sig) return null;
  const hit = memo.get(file);
  if (hit?.sig === sig) return hit.entries;
  const { DatabaseSync } = (await import('node:sqlite')) as any;
  let db: any;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const rows = db.prepare('SELECT idx, step_type, status, step_payload FROM steps ORDER BY idx').all() as Row[];
    const entries = agyEntries(rows);
    memo.set(file, { sig, entries });
    if (memo.size > 16) memo.delete(memo.keys().next().value!);
    return entries;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

// ---------- discovery: what a conversation is, without reading its steps

/** The conversation's folder and start, from its trajectory metadata (1 workspace → 1 uri; 2 created_at). */
export function agyMeta(blob: Uint8Array | null): { cwd: string | null; createdAt: number } {
  const uri = str(msg(blob, 1), 1) || str(blob, 7);
  let cwd: string | null = null;
  if (uri.startsWith('file://')) {
    try {
      cwd = decodeURIComponent(new URL(uri).pathname);
    } catch {}
  }
  return { cwd, createdAt: time(msg(blob, 2)) };
}
