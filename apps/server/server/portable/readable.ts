// A conversation as another session reads it (`ah conversation <target>`): what was said
// and what ran, oldest first, as a hand-off quotes it (server/portable/handoff.ts), with
// where it ran and what the record is missing. Pure: a document in, text out.
import { render } from './handoff.ts';
import type { PortableConversation, PortablePart } from './schema.ts';

export type ReadableOptions = {
  /** Only the last this many messages (what was said; tool results ride with their calls). */
  last?: number;
  /** The harness's display name ("Claude Code"). */
  harnessName?: string;
};

const when = (at: number) => (at > 0 ? new Date(at).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '');

export function readableConversation(conv: PortableConversation, o: ReadableOptions = {}): string {
  const results = new Map<string, Extract<PortablePart, { type: 'tool_result' }>>();
  for (const m of conv.messages) for (const p of m.parts) if (p.type === 'tool_result') results.set(p.callId, p);
  const said = conv.messages.flatMap((m) => {
    if (m.role === 'tool' || m.role === 'system') return [];
    const text = render(m, results);
    if (!text) return [];
    const at = when(m.at);
    // "User · 2026-11-23 09:10Z:" over what was said, as the record's own "User:" heads it.
    return [at ? text.replace(/^(User|Assistant):/, `$1 · ${at}:`) : text];
  });
  const shown = o.last && o.last > 0 ? said.slice(-o.last) : said;
  const where = [conv.cwd && `in ${conv.cwd}`, conv.project.branch && `on ${conv.project.branch}`].filter(Boolean).join(' ');
  const lines = [
    `# ${conv.title || '(untitled)'}`,
    [o.harnessName ?? conv.source.harness, where, conv.source.uid && `ah session ${conv.source.uid}`].filter(Boolean).join(' · '),
    `${said.length} message${said.length === 1 ? '' : 's'}${conv.updatedAt ? `, the last ${when(conv.updatedAt)}` : ''}.`,
  ];
  if (shown.length < said.length) lines.push(`The ${said.length - shown.length} before these are left out (-n 0 shows them all).`);
  const missing = conv.limitations.filter((l) => l.code !== 'no_internal_state').map((l) => l.message);
  if (missing.length) lines.push(`Missing from this record: ${missing.join(' ')}`);
  lines.push('', ...shown.join('\n\n').split('\n'));
  return lines.join('\n') + '\n';
}
