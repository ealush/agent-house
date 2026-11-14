// Token usage from the harnesses' own transcripts (local telemetry): read from where
// the last pass stopped, a bounded amount per pass, so a 200 MB transcript is read
// once, not every minute. Pure parsers below; the cursor and the database are the
// service's (service.ts).
//
// Claude Code writes an assistant message as several lines, one per content block,
// each repeating the message's `usage`: a message counts once, by its id. Codex
// writes a `token_count` event per turn with that turn's tokens (`last_token_usage`)
// and the provider's rate-limit windows. Other harnesses don't record usage there:
// their usage is unknown, and says so.
import { open, stat } from 'node:fs/promises';

export type UsageEvent = {
  day: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

export type LimitEvent = { window: string; usedPercent: number | null; windowMinutes: number | null; resetsAt: number | null; at: number };

/** What a parser carries from one line to the next (per file). */
export type ParseState = { model?: string; seen?: string[] };

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const dayOf = (ts: unknown, fallback: number) => {
  const t = typeof ts === 'string' ? Date.parse(ts) : typeof ts === 'number' ? ts : NaN;
  return new Date(Number.isFinite(t) ? t : fallback).toISOString().slice(0, 10);
};

/** One raw transcript line → usage and limit events. Lines without either cost one indexOf. */
export function parseUsageLine(adapter: string, line: string, state: ParseState, now = Date.now()): { usage: UsageEvent | null; limits: LimitEvent[] } {
  const none = { usage: null, limits: [] as LimitEvent[] };
  if (adapter === 'claude') {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) return none;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return none;
    }
    const m = d?.message;
    const u = m?.usage;
    if (d?.type !== 'assistant' || !u || typeof m.model !== 'string' || m.model === '<synthetic>') return none;
    const id = typeof m.id === 'string' ? m.id : typeof d.requestId === 'string' ? d.requestId : null;
    if (id) {
      const seen = (state.seen ??= []);
      if (seen.includes(id)) return none;
      seen.push(id);
      if (seen.length > 64) seen.splice(0, seen.length - 64);
    }
    return {
      usage: { day: dayOf(d.timestamp, now), model: m.model, inputTokens: n(u.input_tokens), outputTokens: n(u.output_tokens), cacheReadTokens: n(u.cache_read_input_tokens), cacheWriteTokens: n(u.cache_creation_input_tokens), reasoningTokens: 0 },
      limits: [],
    };
  }
  if (adapter === 'codex') {
    if (!line.includes('"token_count"') && !line.includes('"turn_context"')) return none;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return none;
    }
    const p = d?.payload ?? {};
    if (d?.type === 'turn_context' && typeof p.model === 'string') {
      state.model = p.model;
      return none;
    }
    if (d?.type !== 'event_msg' || p.type !== 'token_count') return none;
    const at = Date.parse(d.timestamp) || now;
    const limits: LimitEvent[] = [];
    for (const window of ['primary', 'secondary']) {
      const r = p.rate_limits?.[window];
      if (!r || typeof r !== 'object') continue;
      const resetsAt = typeof r.resets_at === 'number' ? Math.floor(r.resets_at) : typeof r.resets_in_seconds === 'number' ? Math.floor(at / 1000 + r.resets_in_seconds) : null;
      limits.push({ window, usedPercent: typeof r.used_percent === 'number' ? r.used_percent : null, windowMinutes: typeof r.window_minutes === 'number' ? r.window_minutes : null, resetsAt, at: Math.floor(at / 1000) });
    }
    const u = p.info?.last_token_usage;
    if (!u) return { usage: null, limits };
    // OpenAI counts cached input inside input_tokens, and reasoning inside output_tokens.
    const cached = n(u.cached_input_tokens);
    return {
      usage: { day: dayOf(d.timestamp, now), model: state.model ?? 'unknown', inputTokens: Math.max(0, n(u.input_tokens) - cached), outputTokens: n(u.output_tokens), cacheReadTokens: cached, cacheWriteTokens: 0, reasoningTokens: n(u.reasoning_output_tokens) },
      limits,
    };
  }
  return none;
}

export const PASS_BYTES = 32 * 1024 * 1024;

/**
 * Complete lines from `offset`, at most `max` bytes of them. Returns where reading
 * stopped (a line boundary), so an unfinished last line is read again next time.
 */
export async function readFrom(file: string, offset: number, max = PASS_BYTES): Promise<{ lines: string[]; next: number; size: number; ino: number } | null> {
  const s = await stat(file).catch(() => null);
  if (!s) return null;
  if (s.size <= offset) return { lines: [], next: offset, size: s.size, ino: s.ino };
  const length = Math.min(max, s.size - offset);
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (end < 0) {
      // One line longer than the window: skip it rather than stall here forever.
      return { lines: [], next: length === max ? offset + bytesRead : offset, size: s.size, ino: s.ino };
    }
    return { lines: buf.subarray(0, end).toString('utf8').split('\n'), next: offset + end + 1, size: s.size, ino: s.ino };
  } finally {
    await fh.close();
  }
}
