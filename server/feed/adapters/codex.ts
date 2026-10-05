// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. `response_item` lines are
// what the model saw and said; `event_msg` lines mostly duplicate them for the TUI,
// so only the few that add something (an aborted turn) are read.
import type { Entry, Part } from '../schema.ts';
import { imageSrc, ms, parseArgs, textParts, toolResult } from '../parts.ts';

function texts(content: unknown, kind: 'input_text' | 'output_text'): string[] {
  if (typeof content === 'string') return [content];
  return (Array.isArray(content) ? content : []).filter((c) => c?.type === kind && typeof c.text === 'string').map((c) => c.text);
}

/** Codex wraps shell output as JSON `{output, metadata: {exit_code}}`, or plain text. */
function output(raw: unknown): { text: string; isError: boolean; data?: Record<string, unknown>; images: string[] } {
  if (Array.isArray(raw)) {
    const images = raw.filter((c) => c?.type === 'input_image').map((c) => (typeof c.image_url === 'string' && c.image_url.startsWith('data:image/') ? c.image_url : null)).filter(Boolean) as string[];
    return { text: texts(raw, 'input_text').join('\n'), isError: false, images };
  }
  const text = typeof raw === 'string' ? raw : '';
  try {
    const v = JSON.parse(text);
    if (v && typeof v.output === 'string') {
      const exit = v.metadata?.exit_code;
      return { text: v.output, isError: typeof exit === 'number' && exit !== 0, data: v.metadata && typeof v.metadata === 'object' ? v.metadata : undefined, images: [] };
    }
  } catch {}
  const exit = text.match(/^Exit code: (\d+)/m);
  return { text, isError: !!exit && exit[1] !== '0', images: [] };
}

export function parseCodexLine(d: any, seq: number): Entry | null {
  if (!d || typeof d !== 'object') return null;
  const at = ms(d.timestamp);
  const p = d.payload ?? {};
  const id = typeof p.id === 'string' ? p.id : String(seq);
  const entry = (role: Entry['role'], step: Entry['step'], parts: Part[]): Entry | null => (parts.length ? { seq, id, role, step, at, parts } : null);

  if (d.type === 'compacted') return entry('system', 'observation', [{ type: 'notice', kind: 'compacted', text: 'Conversation compacted' }]);
  if (d.type === 'event_msg' && p.type === 'turn_aborted') return entry('system', 'observation', [{ type: 'notice', kind: 'interrupted', text: 'Interrupted' }]);
  if (d.type !== 'response_item') return null;

  switch (p.type) {
    case 'message': {
      if (p.role === 'assistant') return entry('assistant', 'llm_call', texts(p.content, 'output_text').flatMap(textParts));
      if (p.role !== 'user') return null; // developer/system instructions
      const parts: Part[] = [];
      // Environment context, AGENTS.md and other injected blocks start with a tag or heading.
      for (const t of texts(p.content, 'input_text')) if (t.trim() && !/^\s*(<|# AGENTS\.md)/.test(t)) parts.push({ type: 'text', text: t.trim() });
      for (const c of Array.isArray(p.content) ? p.content : []) {
        if (c?.type === 'input_image' && typeof c.image_url === 'string') {
          const m = c.image_url.match(/^data:(image\/[\w.+-]+);base64,(.*)$/);
          const src = m && imageSrc(m[1], m[2]);
          if (src) parts.push({ type: 'media', kind: 'image', src });
        }
      }
      return entry('user', 'message', parts);
    }
    case 'reasoning': {
      const summary = (Array.isArray(p.summary) ? p.summary : []).map((s: any) => s?.text).filter((s: unknown) => typeof s === 'string' && s.trim());
      const content = (Array.isArray(p.content) ? p.content : []).map((s: any) => s?.text).filter((s: unknown) => typeof s === 'string' && s.trim());
      const text = (summary.length ? summary : content).join('\n\n').trim();
      return text ? entry('assistant', 'llm_call', [{ type: 'reasoning', text }]) : null;
    }
    case 'function_call':
    case 'custom_tool_call': {
      if (typeof p.call_id !== 'string') return null;
      const args = parseArgs(p.type === 'function_call' ? p.arguments : p.input);
      return entry('assistant', 'tool_execution', [{ type: 'tool_call', call: { id: p.call_id, name: String(p.name ?? 'tool'), args } }]);
    }
    case 'local_shell_call': {
      if (typeof p.call_id !== 'string') return null;
      const command = Array.isArray(p.action?.command) ? p.action.command.join(' ') : '';
      return entry('assistant', 'tool_execution', [{ type: 'tool_call', call: { id: p.call_id, name: 'shell', args: { command } } }]);
    }
    case 'web_search_call': {
      const callId = typeof p.id === 'string' ? p.id : `search-${seq}`;
      const query = typeof p.action?.query === 'string' ? p.action.query : '';
      return entry('assistant', 'tool_execution', [
        { type: 'tool_call', call: { id: callId, name: 'web_search', args: { query } } },
        toolResult(callId, '', p.status === 'failed'),
      ]);
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'local_shell_call_output': {
      if (typeof p.call_id !== 'string') return null;
      const o = output(p.output);
      return entry('tool', 'observation', [toolResult(p.call_id, o.text, o.isError, { ...(o.data ? { data: o.data } : {}), ...(o.images.length ? { images: o.images } : {}) })]);
    }
  }
  return null;
}
