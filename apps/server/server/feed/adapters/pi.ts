// pi: ~/.pi/agent/sessions/--<cwd>--/<timestamp>_<id>.jsonl, one entry a line (docs/session-format.md
// in pi's package). Entries form a tree (id/parentId) so /tree can branch in place; the file is
// read in the order it was written, which is the conversation as it happened, branches included.
// `message` lines carry what was said; model and thinking changes, labels and extension state
// carry nothing to show.
import type { Entry, Part } from '../schema.ts';
import { imageSrc, ms, parseArgs, textParts, toolResult } from '../parts.ts';

/** pi's tools under the argument names the chat views read (file_path, old_string, …). */
function viewArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const path = typeof args.path === 'string' ? { file_path: args.path } : {};
  if (name !== 'edit') return { ...args, ...path };
  // `edits: [{oldText, newText}]`, or the older single `oldText`/`newText`.
  const edits = (Array.isArray(args.edits) ? args.edits : [args]).filter((e: any) => typeof e?.oldText === 'string' && typeof e?.newText === 'string') as { oldText: string; newText: string }[];
  if (!edits.length) return { ...args, ...path };
  return { ...args, ...path, old_string: edits.map((e) => e.oldText).join('\n…\n'), new_string: edits.map((e) => e.newText).join('\n…\n') };
}

function content(c: unknown): any[] {
  return typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
}

function image(c: any): Part | null {
  const src = imageSrc(c?.mimeType, c?.data);
  return src ? { type: 'media', kind: 'image', src } : null;
}

export function parsePiLine(d: any, seq: number): Entry | null {
  if (!d || typeof d !== 'object') return null;
  const at = ms(d.timestamp);
  const id = typeof d.id === 'string' ? d.id : String(seq);
  const entry = (role: Entry['role'], step: Entry['step'], parts: Part[]): Entry | null => (parts.length ? { seq, id, role, step, at, parts } : null);

  if (d.type === 'compaction') return entry('system', 'observation', [{ type: 'notice', kind: 'compacted', text: 'Conversation compacted' }]);
  if (d.type === 'branch_summary') return entry('system', 'observation', [{ type: 'notice', kind: 'info', text: 'Went back to an earlier point' }]);
  if (d.type === 'custom_message' && d.display === true) {
    return entry('system', 'observation', content(d.content).filter((c) => c?.type === 'text' && typeof c.text === 'string' && c.text.trim()).map((c) => ({ type: 'notice' as const, kind: 'info' as const, text: c.text.trim() })));
  }
  if (d.type !== 'message') return null;
  const m = d.message ?? {};

  switch (m.role) {
    case 'user': {
      const parts: Part[] = [];
      for (const c of content(m.content)) {
        if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) parts.push({ type: 'text', text: c.text.trim() });
        else if (c?.type === 'image') parts.push(image(c) ?? { type: 'notice', kind: 'info', text: 'Image attached' });
      }
      return entry('user', 'message', parts);
    }
    case 'assistant': {
      const parts: Part[] = [];
      for (const c of content(m.content)) {
        if (c?.type === 'text' && typeof c.text === 'string') parts.push(...textParts(c.text));
        else if (c?.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim()) parts.push({ type: 'reasoning', text: c.thinking.trim() });
        else if (c?.type === 'toolCall' && typeof c.id === 'string') {
          const name = String(c.name ?? 'tool');
          parts.push({ type: 'tool_call', call: { id: c.id, name, args: viewArgs(name, parseArgs(c.arguments)) } });
        }
      }
      // What stopped a turn short: Stop, or the provider's error (out of quota, a bad key).
      if (m.stopReason === 'aborted') parts.push({ type: 'notice', kind: 'interrupted', text: 'Interrupted' });
      else if (m.stopReason === 'error') parts.push({ type: 'notice', kind: 'info', text: typeof m.errorMessage === 'string' && m.errorMessage.trim() ? m.errorMessage.trim() : 'The model returned an error' });
      return entry('assistant', parts.some((p) => p.type === 'tool_call') ? 'tool_execution' : 'llm_call', parts);
    }
    case 'toolResult': {
      if (typeof m.toolCallId !== 'string') return null;
      const items = content(m.content);
      const text = items.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
      const images = items.filter((c) => c?.type === 'image').map((c) => imageSrc(c.mimeType, c.data)).filter((s): s is string => !!s);
      return entry('tool', 'observation', [toolResult(m.toolCallId, text, m.isError === true, images.length ? { images } : {})]);
    }
    case 'bashExecution': {
      // `!command` typed in pi's editor: run by you, not the model.
      const command = typeof m.command === 'string' ? m.command : '';
      if (!command) return null;
      const callId = `bash-${id}`;
      return entry('assistant', 'tool_execution', [
        { type: 'tool_call', call: { id: callId, name: 'bash', args: { command } } },
        toolResult(callId, typeof m.output === 'string' ? m.output : '', (typeof m.exitCode === 'number' && m.exitCode !== 0) || m.cancelled === true),
      ]);
    }
  }
  return null;
}
