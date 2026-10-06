// Muse (Meta's Muse Code CLI): ~/.local/share/muse/sessions/YYYY/MM/DD/
// <session-id>/session.jsonl. Append-only JSONL where every line is an envelope:
// { schema_version, id, stream: { kind, id }, sequence, recorded_at, payload_type,
// payload }. Conversation lives in `runtime.session` records whose payload.kind is
// "run", discriminated by payload.event.kind; everything else is telemetry.
// `recorded_at` is MICROseconds since the epoch. Tool call `args` is a
// JSON-encoded string. The session id is `stream.id`; the cwd arrives in a
// separate `runtime.session.metadata` record (payload.record.workspace_root),
// which only discovery reads.
//
// Format status: documented from a third-party reverse-engineering report run
// against a real corpus (Muse Code 0.1.0, Linux), NOT verified against a local
// Muse install. Only the four conversation event kinds reported there are
// mapped; unknown event kinds are skipped. `reasoning_committed` is mapped
// defensively (text or summary) because its payload shape was not published.
import type { Entry, Part } from '../schema.ts';
import { ms, parseArgs, textParts, toolResult } from '../parts.ts';

export function parseMuseLine(d: any, seq: number): Entry | null {
  if (!d || typeof d !== 'object' || d.payload_type !== 'runtime.session') return null;
  const p = d.payload ?? {};
  if (p.kind !== 'run') return null;
  const ev = p.event ?? {};
  const at = typeof d.recorded_at === 'number' ? Math.floor(d.recorded_at / 1000) : ms(d.recorded_at);
  const id = typeof d.id === 'string' ? d.id : String(seq);
  const entry = (role: Entry['role'], step: Entry['step'], parts: Part[]): Entry | null => (parts.length ? { seq, id, role, step, at, parts } : null);

  switch (ev.kind) {
    case 'started': {
      const text = typeof ev.prompt === 'string' ? ev.prompt.trim() : '';
      return text ? entry('user', 'message', [{ type: 'text', text }]) : null;
    }
    case 'assistant_message_committed': {
      const text = typeof ev.text === 'string' ? ev.text : '';
      return entry('assistant', 'llm_call', text.trim() ? textParts(text) : []);
    }
    case 'assistant_tool_calls_committed': {
      const parts: Part[] = [];
      if (typeof ev.text === 'string' && ev.text.trim()) parts.push(...textParts(ev.text));
      for (const c of Array.isArray(ev.tool_calls) ? ev.tool_calls : []) {
        if (typeof c?.call_id !== 'string' || typeof c?.name !== 'string') continue;
        parts.push({ type: 'tool_call', call: { id: c.call_id, name: c.name, args: parseArgs(c.args) } });
      }
      return entry('assistant', 'tool_execution', parts);
    }
    case 'tool_result_batch_committed': {
      const parts: Part[] = [];
      for (const r of Array.isArray(ev.results) ? ev.results : []) {
        if (typeof r?.tool_call_id !== 'string') continue;
        const isError = r.is_error === true || r.status === 'error' || r.status === 'failed';
        parts.push(toolResult(r.tool_call_id, typeof r.text === 'string' ? r.text : '', isError));
      }
      return entry('tool', 'observation', parts);
    }
    case 'reasoning_committed': {
      const text = typeof ev.text === 'string' ? ev.text : typeof ev.summary === 'string' ? ev.summary : '';
      return text.trim() ? entry('assistant', 'llm_call', [{ type: 'reasoning', text: text.trim() }]) : null;
    }
  }
  return null;
}
