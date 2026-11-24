// Pure helpers for the ah CLI (bin/cli.js): duration parsing, SSE delta merging,
// fleet event diffing, picker choice resolution, and human-readable formatting.
import type { Ask, WindowView } from './sessions.ts';
import type { ScreenOption } from './choices.ts';
import type { Entry } from './feed/schema.ts';

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

/**
 * Parses a duration like "30s", "5m", "2h", "1d", or compound "1h30m" into seconds.
 * Returns null if invalid or zero.
 */
export function parseDuration(input: unknown): number | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  let total = 0;
  let pos = 0;
  for (const m of s.matchAll(/(\d+)(s|m|h|d)/g)) {
    if (m.index !== pos) return null;
    total += Number(m[1]) * UNITS[m[2]];
    pos += m[0].length;
  }
  return pos === s.length && total > 0 ? total : null;
}

/** Formats seconds as a compact span ("45s", "5m", "2h", "1d"). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const s = Math.floor(seconds);
  if (s % 86_400 === 0) return `${s / 86_400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

export type SseFrame = { event: string; data: unknown };

/**
 * Incremental Server-Sent Events parser. Feeds chunks in, calls `onFrame({ event, data })`
 * for each complete frame, and returns the remaining buffered bytes.
 */
export function parseSseChunk(buf: string, chunk: string, onFrame: (frame: SseFrame) => void): string {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const raw = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    try {
      onFrame({ event, data: JSON.parse(dataLines.join('\n')) });
    } catch {
      onFrame({ event, data: dataLines.join('\n') });
    }
  }
  return buf;
}

type StateLike = {
  windows?: Array<{ uid: string } & Record<string, unknown>>;
  windowsDelta?: { order?: string[]; changed?: Array<{ uid: string } & Record<string, unknown>> };
  [key: string]: unknown;
};

/**
 * Applies a `/api/events?delta=1` patch frame onto a state snapshot, returning the next state.
 */
export function applyStateDelta<T extends StateLike>(prev: T | null, patch: StateLike): T {
  if (!prev) return patch as T;
  const next: StateLike = { ...prev, ...patch };
  if (patch.windowsDelta) {
    const byUid = new Map((prev.windows ?? []).map((w) => [w.uid, w]));
    for (const w of patch.windowsDelta.changed ?? []) byUid.set(w.uid, w);
    next.windows = (patch.windowsDelta.order ?? []).map((uid) => byUid.get(uid)).filter((w): w is { uid: string } & Record<string, unknown> => !!w);
    delete next.windowsDelta;
  }
  return next as T;
}

export type FleetWindow = Pick<WindowView, 'uid' | 'title' | 'name' | 'agent' | 'status' | 'ask' | 'askId' | 'answerable' | 'reply'>;

export type FleetEvent = {
  event: 'started' | 'ended' | 'status' | 'ask' | 'reply';
  at: number;
  uid: string;
  title: string;
  agent: string | null;
  status?: WindowView['status'];
  from?: WindowView['status'];
  to?: WindowView['status'];
  ask?: Ask | null;
  askId?: string | null;
  answerable?: boolean;
  reply?: WindowView['reply'];
  window: FleetWindow;
};

/**
 * Computes semantic fleet events between two window lists, optionally scoped to `onlyUids`.
 * Emits: started, ended, status, ask, reply.
 */
export function diffFleet(prevWindows: FleetWindow[] | undefined, nextWindows: FleetWindow[] | undefined, onlyUids: Set<string> | null = null): FleetEvent[] {
  const prev = new Map((prevWindows ?? []).map((w) => [w.uid, w]));
  const next = new Map((nextWindows ?? []).map((w) => [w.uid, w]));
  const keep = (uid: string) => !onlyUids || onlyUids.has(uid);
  const events: FleetEvent[] = [];
  const at = Math.floor(Date.now() / 1000);

  for (const [uid, w] of next) {
    if (!keep(uid)) continue;
    const old = prev.get(uid);
    if (!old) {
      events.push({ event: 'started', at, uid, title: w.title || w.name, agent: w.agent, status: w.status, window: w });
      if (w.status === 'waiting') {
        events.push({ event: 'ask', at, uid, title: w.title || w.name, agent: w.agent, ask: w.ask, askId: w.askId, answerable: w.answerable, window: w });
      }
      continue;
    }
    if (old.status !== w.status) {
      events.push({
        event: 'status',
        at,
        uid,
        title: w.title || w.name,
        agent: w.agent,
        from: old.status,
        to: w.status,
        ask: w.ask,
        askId: w.askId,
        answerable: w.answerable,
        reply: w.reply ?? null,
        window: w,
      });
    }
    if (w.status === 'waiting' && w.askId && w.askId !== old.askId) {
      events.push({
        event: 'ask',
        at,
        uid,
        title: w.title || w.name,
        agent: w.agent,
        ask: w.ask,
        askId: w.askId,
        answerable: w.answerable,
        window: w,
      });
    }
    const oldReply = old.reply ? `${old.reply.at}:${old.reply.text}` : '';
    const newReply = w.reply ? `${w.reply.at}:${w.reply.text}` : '';
    if (w.reply && newReply !== oldReply) {
      events.push({
        event: 'reply',
        at,
        uid,
        title: w.title || w.name,
        agent: w.agent,
        reply: w.reply,
        window: w,
      });
    }
  }
  for (const [uid, old] of prev) {
    if (!keep(uid) || next.has(uid)) continue;
    events.push({ event: 'ended', at, uid, title: old.title || old.name, agent: old.agent, window: old });
  }
  return events;
}

/**
 * Resolves a user/orchestrator choice ("1", "2", "y", "nav:0") against `ask.options`.
 * Handles digit keys, letter hotkeys, and 1-based indexing into cursor-navigated (`nav:N`) lists.
 */
export function resolvePickerChoice(options: ScreenOption[] | undefined, rawChoice: string): ScreenOption | null {
  if (!Array.isArray(options) || !options.length) return null;
  const choice = String(rawChoice ?? '').trim();
  const lower = choice.toLowerCase();
  const exact = options.find((o) => o.key === choice || o.key.toLowerCase() === lower);
  if (exact) return exact;
  if (/^\d+$/.test(choice)) {
    const idx = Number(choice) - 1;
    if (idx >= 0 && idx < options.length && options[idx].key.startsWith('nav:')) return options[idx];
  }
  return null;
}

/** Formats a waiting session's `ask` for terminal display. */
export function formatAsk(ask: Ask | null | undefined, { askId = null, answerable = false }: { askId?: string | null; answerable?: boolean } = {}): string[] {
  if (!ask) return [];
  const lines: string[] = [];
  const flags = [ask.kind, answerable ? 'approve/deny' : null, askId ? `id=${askId}` : null].filter(Boolean).join(', ');
  lines.push(`Ask (${flags}):`);
  if (ask.text) {
    for (const l of ask.text.split('\n').slice(0, 12)) lines.push(`  ${l}`);
  }
  if (ask.gate) {
    const g = ask.gate;
    lines.push(`  Gate: ${g.kind}${g.input ? ' (expects text)' : ''}${g.back ? ' (Esc goes back)' : ''}${g.callback ? ` (callback ${g.callback})` : ''}`);
    if (g.code) lines.push(`  Code: ${g.code}`);
    for (const url of g.links ?? []) lines.push(`  Link: ${url}`);
  }
  if (ask.options?.length) {
    lines.push('  Options:');
    ask.options.forEach((o, i) => {
      const key = o.key.startsWith('nav:') ? String(i + 1) : o.key;
      lines.push(`    ${key}. ${o.label}`);
    });
  }
  if (ask.questions?.length) {
    lines.push(`  Questions (${ask.questions.length}):`);
    ask.questions.forEach((q, i) => {
      lines.push(`    Q${i + 1}: ${q.question}${q.multiSelect ? ' [multi]' : ''}`);
      (q.options ?? []).forEach((o, j) => lines.push(`      ${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`));
    });
  } else if (ask.dialog) {
    lines.push(`  Dialog question: ${ask.dialog.question}${ask.dialog.multiSelect ? ' [multi]' : ''}`);
    (ask.dialog.options ?? []).forEach((o, j) => lines.push(`    ${j + 1}. ${o.label}`));
  }
  return lines;
}

/** Formats structured feed entries (`GET /api/sessions/:ref/feed`) into readable text. */
export function formatFeedEntries(entries: Array<Pick<Entry, 'role' | 'at' | 'parts'>> | undefined): string {
  const out: string[] = [];
  for (const e of entries ?? []) {
    const who = e.role === 'user' ? 'USER' : e.role === 'assistant' ? 'ASSISTANT' : String(e.role ?? 'ENTRY').toUpperCase();
    const when = e.at ? ` (${new Date(e.at).toLocaleTimeString()})` : '';
    const chunks: string[] = [];
    for (const p of e.parts ?? []) {
      if (p.type === 'text' && p.text) chunks.push(p.text);
      else if (p.type === 'tool_call') chunks.push(`[tool: ${p.call?.name ?? '?'}] ${JSON.stringify(p.call?.args ?? {}).slice(0, 240)}`);
      else if (p.type === 'tool_result') chunks.push(`[result${p.result?.isError ? ' ERROR' : ''}] ${String(p.result?.text ?? '').slice(0, 400)}`);
    }
    if (!chunks.length) continue;
    out.push(`--- ${who}${when} ---\n${chunks.join('\n')}`);
  }
  return out.join('\n\n') + (out.length ? '\n' : '');
}
