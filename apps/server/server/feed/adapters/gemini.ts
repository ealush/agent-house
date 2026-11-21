// Gemini CLI: ~/.gemini/tmp/<project-dir>/chats/session-<ts>-<id>.jsonl in
// current versions, written by the harness's chat recording service. Line 1 is
// a metadata record ({ sessionId, projectHash, startTime, lastUpdated, kind,
// directories, summary }); each later line is one message record ({ id,
// timestamp, type, content, ... }). `$set` lines patch session metadata and
// carry no conversation. `content` is a PartListUnion: a string, or an array
// of parts ({ text }, { functionCall }, { functionResponse }). `gemini`
// records also carry `thoughts` ([{ subject, description }]) and `toolCalls`
// ([{ id, name, args, result, status }]) with the result folded onto the call.
// Older versions wrote the same shape as one JSON document
// ({ sessionId, ..., messages: [...] }); parseGeminiDocument covers that form
// and the document feed (server/feed/feed.ts) serves it.
//
// Format status: documented from the upstream recording service's published
// shape via third-party readers of real installs, NOT verified against a local
// Gemini install. Known limitation: the live writer may re-append a message
// record as its tokens and tool calls land; the line reader shows each append
// as written rather than folding by id (folding needs a stateful projection).
// Unknown record types and parts are skipped.
import { readFile } from 'node:fs/promises';
import type { Entry, Part } from '../schema.ts';
import { ms, parseArgs, textParts, toolResult } from '../parts.ts';

type Extracted = { texts: string[]; calls: Part[]; results: Part[] };

/** Splits a Gemini PartListUnion into text, tool calls and tool results. */
function extract(content: unknown, seq: number): Extracted {
  const out: Extracted = { texts: [], calls: [], results: [] };
  if (typeof content === 'string') {
    if (content.trim()) out.texts.push(content);
    return out;
  }
  (Array.isArray(content) ? content : []).forEach((p: any, i: number) => {
    if (typeof p?.text === 'string') {
      if (p.text.trim()) out.texts.push(p.text);
    } else if (p?.functionCall && typeof p.functionCall === 'object') {
      const fc = p.functionCall;
      const id = typeof fc.id === 'string' ? fc.id : `gemini-call-${seq}-${i}`;
      out.calls.push({ type: 'tool_call', call: { id, name: String(fc.name ?? 'tool'), args: parseArgs(fc.args) } });
    } else if (p?.functionResponse && typeof p.functionResponse === 'object') {
      const fr = p.functionResponse;
      const r = fr.response ?? {};
      const text = typeof r?.output === 'string' ? r.output : typeof r === 'string' ? r : JSON.stringify(r ?? '');
      const isError = !!r?.error || r?.success === false || (typeof r?.exit_code === 'number' && r.exit_code !== 0);
      const id = typeof fr.id === 'string' ? fr.id : `gemini-call-${seq}-${i}`;
      out.results.push(toolResult(id, text === '{}' ? '' : text, isError));
    }
  });
  return out;
}

function resultText(result: unknown): string {
  if (result === undefined || result === null) return '';
  return extract(result, 0).texts.join('\n') || (typeof result === 'string' ? result : '');
}

const OK_STATUS = new Set(['success', 'succeeded', 'ok', 'completed', 'done']);

export function parseGeminiRecord(d: any, seq: number): Entry | null {
  if (!d || typeof d !== 'object' || typeof d.type !== 'string') return null;
  const at = ms(d.timestamp);
  const id = typeof d.id === 'string' ? d.id : String(seq);
  const entry = (role: Entry['role'], step: Entry['step'], parts: Part[]): Entry | null => (parts.length ? { seq, id, role, step, at, parts } : null);

  if (d.type === 'user') {
    const { texts, calls, results } = extract(d.content, seq);
    const parts: Part[] = [...texts.flatMap(textParts), ...calls, ...results];
    const tool = parts.length > 0 && parts.every((p) => p.type === 'tool_result');
    return entry(tool ? 'tool' : 'user', tool ? 'observation' : 'message', parts);
  }
  if (d.type === 'gemini') {
    const parts: Part[] = [];
    const thoughts = (Array.isArray(d.thoughts) ? d.thoughts : [])
      .map((t: any) => [t?.subject, t?.description].filter((s: unknown) => typeof s === 'string' && s.trim()).join(': '))
      .filter(Boolean);
    if (thoughts.length) parts.push({ type: 'reasoning', text: thoughts.join('\n') });
    const { texts, calls, results } = extract(d.displayContent ?? d.content, seq);
    parts.push(...texts.flatMap(textParts), ...calls, ...results);
    for (const c of Array.isArray(d.toolCalls) ? d.toolCalls : []) {
      if (typeof c?.name !== 'string') continue;
      const callId = typeof c.id === 'string' ? c.id : `gemini-call-${seq}-${parts.length}`;
      parts.push({ type: 'tool_call', call: { id: callId, name: c.name, args: parseArgs(c.args) } });
      if (c.result !== undefined && c.result !== null) {
        const isError = typeof c.status === 'string' && !OK_STATUS.has(c.status.toLowerCase());
        parts.push(toolResult(callId, resultText(c.result), isError));
      }
    }
    const step = parts.some((p) => p.type === 'tool_call') ? 'tool_execution' : 'llm_call';
    return entry('assistant', step, parts);
  }
  if (d.type === 'info' || d.type === 'warning' || d.type === 'error') {
    const { texts } = extract(d.content, seq);
    const text = texts.join('\n').trim();
    return text ? entry('system', 'observation', [{ type: 'notice', kind: 'info', text }]) : null;
  }
  return null;
}

/** Line adapter: metadata and `$set` records carry no conversation. */
export function parseGeminiLine(d: any, seq: number): Entry | null {
  if (!d || typeof d !== 'object') return null;
  if (d.$set || (d.sessionId && !d.type)) return null;
  return parseGeminiRecord(d, seq);
}

/** Whole-document form (older versions): messages become entries by index. */
export function parseGeminiDocument(doc: any): Entry[] {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.messages)) return [];
  const out: Entry[] = [];
  doc.messages.forEach((m: any, i: number) => {
    const e = parseGeminiRecord(m, i + 1);
    if (e) out.push(e);
  });
  return out;
}

/**
 * Document loader for the legacy single-document form, registered in
 * DOC_ADAPTERS under `gemini-doc`. Returns null for the JSONL form (the line
 * adapter owns it) and for a file caught mid-rewrite.
 */
export async function loadGeminiDocument(file: string): Promise<Entry[] | null> {
  const text = await readFile(file, 'utf8').catch(() => '');
  if (!text.trimStart().startsWith('{')) return null;
  try {
    const doc = JSON.parse(text);
    return Array.isArray(doc?.messages) ? parseGeminiDocument(doc) : null;
  } catch {
    return null;
  }
}
