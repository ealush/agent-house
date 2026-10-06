// Grok (xAI Grok Build CLI): ~/.grok/sessions/<percent-encoded-cwd>/<session-id>/
// chat_history.jsonl, one JSON object per line, discriminated by `type`.
// Metadata (cwd, title, model, timestamps) lives in the sibling summary.json;
// chat lines carry no timestamps at all, so `at` is 0 here and ordering is the
// line number, as the schema requires.
//
// Format status: documented from third-party readers of real installs
// (2026-09 to 2026-10), NOT verified against a local Grok install. Field shapes
// below follow those reports: user content is an array of text blocks, real
// prompts are <user_query>-wrapped and carry `prompt_index`, injected context
// carries `synthetic_reason` or no `prompt_index`; assistant content is a bare
// string with a top-level `tool_calls` array whose `arguments` is a JSON
// string; `tool_result` lines link back with `tool_call_id` and have no error
// flag (error text conventionally starts with "Error:"). Unknown record types
// are skipped, per the format's open type set.
import type { Entry, Part } from '../schema.ts';
import { imageSrc, parseArgs, textParts, toolResult } from '../parts.ts';

/** Text of a user line, or null when the line is injected context, not a person. */
function userText(d: any): string | null {
  if (d.synthetic_reason) return null;
  const blocks = Array.isArray(d.content) ? d.content : typeof d.content === 'string' ? [{ type: 'text', text: d.content }] : [];
  const text = blocks.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n');
  const wrapped = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (wrapped) return wrapped[1].trim() || null;
  // No wrapper: a human turn only when the harness counted it as a prompt.
  if (d.prompt_index === undefined) return null;
  const t = text.trim();
  if (!t || t.startsWith('<')) return null;
  return t;
}

export function parseGrokLine(d: any, seq: number): Entry | null {
  if (!d || typeof d !== 'object') return null;
  const id = String(seq);
  const entry = (role: Entry['role'], step: Entry['step'], parts: Part[]): Entry | null => (parts.length ? { seq, id, role, step, at: 0, parts } : null);

  switch (d.type) {
    case 'user': {
      const blocks = Array.isArray(d.content) ? d.content : [];
      const images: Part[] = [];
      for (const c of blocks) {
        if (c?.type !== 'image') continue;
        const m = typeof c.url === 'string' ? c.url.match(/^data:(image\/[\w.+-]+);base64,(.*)$/) : null;
        const src = m ? imageSrc(m[1], m[2]) : null;
        images.push(src ? { type: 'media', kind: 'image', src } : { type: 'notice', kind: 'info', text: 'Image attached' });
      }
      const text = userText(d);
      const parts: Part[] = [...(text ? [{ type: 'text', text } as Part] : []), ...(text ? images : [])];
      return entry('user', 'message', parts);
    }
    case 'assistant': {
      const parts: Part[] = [];
      if (typeof d.content === 'string' && d.content.trim()) parts.push(...textParts(d.content));
      for (const c of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        if (typeof c?.id !== 'string' || typeof c?.name !== 'string') continue;
        parts.push({ type: 'tool_call', call: { id: c.id, name: c.name, args: parseArgs(c.arguments) } });
      }
      const step = parts.some((p) => p.type === 'tool_call') ? 'tool_execution' : 'llm_call';
      return entry('assistant', step, parts);
    }
    case 'reasoning': {
      const text = (Array.isArray(d.summary) ? d.summary : [])
        .map((s: any) => s?.text)
        .filter((s: unknown) => typeof s === 'string' && s.trim())
        .join('\n\n')
        .trim();
      return text ? entry('assistant', 'llm_call', [{ type: 'reasoning', text }]) : null;
    }
    case 'tool_result': {
      if (typeof d.tool_call_id !== 'string') return null;
      const text = typeof d.content === 'string' ? d.content : '';
      const images = (Array.isArray(d.images) ? d.images : [])
        .map((c: any) => {
          const m = typeof c?.url === 'string' ? c.url.match(/^data:(image\/[\w.+-]+);base64,(.*)$/) : null;
          return m ? imageSrc(m[1], m[2]) : null;
        })
        .filter(Boolean) as string[];
      const isError = /^Error\b/.test(text.trim());
      return entry('tool', 'observation', [toolResult(d.tool_call_id, text, isError, images.length ? { images } : {})]);
    }
    case 'backend_tool_call': {
      // Server-side tools (for example web search): no matching tool_result line.
      const kind = d.kind ?? {};
      const name = typeof kind.tool_type === 'string' ? kind.tool_type : 'backend_tool';
      const callId = `backend-${seq}`;
      return entry('assistant', 'tool_execution', [
        { type: 'tool_call', call: { id: callId, name, args: parseArgs(kind.action ?? {}) } },
        toolResult(callId, '', false),
      ]);
    }
  }
  return null;
}
