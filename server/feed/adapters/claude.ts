// Claude Code: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl. One line per
// message content block; tool results come back as user lines carrying
// `tool_result` blocks plus a structured `toolUseResult`.
import type { Entry, Part } from '../schema.ts';
import { imageSrc, ms, parseArgs, smallData, textParts, toolResult } from '../parts.ts';

const COMMAND = /<command-name>([^<]*)<\/command-name>/;
const ARGS = /<command-args>([^<]*)<\/command-args>/;
const STDOUT = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;

/** What a person typed, or null for text the harness injected into the turn. */
function userText(text: string): Part | null {
  const t = text.trim();
  if (!t) return null;
  const cmd = t.match(COMMAND);
  if (cmd) return { type: 'text', text: `${cmd[1].trim()} ${t.match(ARGS)?.[1].trim() ?? ''}`.trim() };
  const out = t.match(STDOUT);
  if (out) return out[1].trim() ? { type: 'notice', kind: 'info', text: out[1].trim() } : null;
  if (/^\[Request interrupted by user/.test(t)) return { type: 'notice', kind: 'interrupted', text: 'Interrupted' };
  // System reminders, caveats, task notifications, image size notes…
  if (t.startsWith('<') || t.startsWith('[') || t.startsWith('Caveat:')) return null;
  return { type: 'text', text: t };
}

function resultText(content: unknown): { text: string; images: string[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  const texts: string[] = [];
  const images: string[] = [];
  for (const c of Array.isArray(content) ? content : []) {
    if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text);
    else if (c?.type === 'image') {
      const src = imageSrc(c.source?.media_type, c.source?.data);
      if (src) images.push(src);
    }
  }
  return { text: texts.join('\n'), images };
}

export function parseClaudeLine(d: any, seq: number): Entry | null {
  if (!d || typeof d !== 'object' || d.isSidechain) return null;
  const at = ms(d.timestamp);
  const id = typeof d.uuid === 'string' ? d.uuid : String(seq);

  if (d.type === 'system') {
    if (d.subtype === 'compact_boundary') return { seq, id, role: 'system', step: 'observation', at, parts: [{ type: 'notice', kind: 'compacted', text: 'Conversation compacted' }] };
    return null;
  }
  if (d.type !== 'user' && d.type !== 'assistant') return null;
  if (d.isMeta || d.isCompactSummary) return null;
  const content = d.message?.content;
  const parts: Part[] = [];

  if (d.type === 'assistant') {
    for (const c of Array.isArray(content) ? content : []) {
      if (c?.type === 'text' && typeof c.text === 'string') parts.push(...textParts(c.text));
      else if (c?.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim()) parts.push({ type: 'reasoning', text: c.thinking.trim() });
      else if (c?.type === 'tool_use' && typeof c.id === 'string') parts.push({ type: 'tool_call', call: { id: c.id, name: String(c.name ?? 'tool'), args: parseArgs(c.input) } });
    }
    if (!parts.length) return null;
    const step = parts.some((p) => p.type === 'tool_call') ? 'tool_execution' : 'llm_call';
    return { seq, id, role: 'assistant', step, at, parts };
  }

  if (typeof content === 'string') {
    const p = userText(content);
    if (p) parts.push(p);
  }
  for (const c of Array.isArray(content) ? content : []) {
    if (c?.type === 'text' && typeof c.text === 'string') {
      const p = userText(c.text);
      if (p) parts.push(p);
    } else if (c?.type === 'image') {
      const src = imageSrc(c.source?.media_type, c.source?.data);
      parts.push(src ? { type: 'media', kind: 'image', src } : { type: 'notice', kind: 'info', text: 'Image attached' });
    } else if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') {
      const { text, images } = resultText(c.content);
      // The file body and the pre-edit original are large and already in the args.
      const data = smallData(d.toolUseResult, ['originalFile', 'file', 'content']);
      parts.push(toolResult(c.tool_use_id, text, c.is_error === true, { ...(data ? { data } : {}), ...(images.length ? { images } : {}) }));
    }
  }
  if (!parts.length) return null;
  const tool = parts.every((p) => p.type === 'tool_result');
  return { seq, id, role: tool ? 'tool' : 'user', step: tool ? 'observation' : 'message', at, parts };
}
