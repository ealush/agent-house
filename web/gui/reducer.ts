// The GUI is a reducer over an ordered event log, not a terminal emulator.
// Entries are keyed by `seq` (the only ordering authority): overlapping deliveries
// dedupe, older pages merge in front, and a snapshot replaces the projection.
import type { Entry, FeedMessage, FeedPage, Part, ToolCall, ToolResult } from '../../server/feed/schema.ts';

export type FeedState = {
  status: 'connecting' | 'live' | 'unavailable';
  reason: string | null;
  harness: string;
  entries: Entry[];
  /** Tool results by call id: a call is complete once its result is here. */
  results: Record<string, ToolResult>;
  hasOlder: boolean;
  /** Bumped when the projection is rebuilt (new transcript, truncated file). */
  epoch: number;
};

/** What this browser kept of a conversation (web/gui/feedCache.ts), shown until the stream catches up. */
export type CachedFeed = { harness: string; entries: Entry[]; hasOlder: boolean };

export type Action = FeedMessage | ({ type: 'older' } & FeedPage) | ({ type: 'cached' } & CachedFeed) | { type: 'disconnected' };

export const initialFeed: FeedState = { status: 'connecting', reason: null, harness: '', entries: [], results: {}, hasOlder: false, epoch: 0 };

function merge(a: Entry[], b: Entry[]): Entry[] {
  if (!b.length) return a;
  const bySeq = new Map(a.map((e) => [e.seq, e]));
  for (const e of b) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

function withResults(results: Record<string, ToolResult>, entries: Entry[]): Record<string, ToolResult> {
  let out = results;
  for (const e of entries) {
    for (const p of e.parts) {
      if (p.type !== 'tool_result') continue;
      if (out === results) out = { ...results };
      out[p.result.callId] = p.result;
    }
  }
  return out;
}

export function reduce(s: FeedState, a: Action): FeedState {
  switch (a.type) {
    case 'snapshot':
      return {
        status: 'live',
        reason: null,
        harness: a.harness,
        entries: merge([], a.entries),
        results: withResults({}, a.entries),
        hasOlder: a.hasOlder,
        // A reconnect re-sends the same transcript from the top: not a rebuild.
        epoch: a.reason === 'initial' ? s.epoch : s.epoch + 1,
      };
    case 'append':
      return { ...s, status: 'live', entries: merge(s.entries, a.entries), results: withResults(s.results, a.entries) };
    case 'older':
      return { ...s, entries: merge(s.entries, a.entries), results: withResults(s.results, a.entries), hasOlder: a.hasOlder };
    case 'unavailable':
      return { ...initialFeed, status: 'unavailable', reason: a.reason, epoch: s.epoch + 1 };
    case 'cached':
      // Only into an empty view that is still waiting: the stream always wins.
      if (s.entries.length || s.status !== 'connecting') return s;
      return { ...s, harness: a.harness, entries: merge([], a.entries), results: withResults({}, a.entries), hasOlder: a.hasOlder };
    case 'disconnected':
      return s.status === 'live' ? { ...s, status: 'connecting' } : s;
  }
}

// ---------- projection: entries → blocks the timeline renders

export type Item = { kind: 'part'; key: string; part: Part } | { kind: 'tools'; key: string; calls: ToolCall[] };

/**
 * Plain text a message block copies as: the message prose. Tool calls and
 * results, widgets, media, and (collapsed) reasoning are never included.
 */
export function blockText(block: Block): string {
  if (block.kind === 'notice') return block.part.text;
  if (block.kind === 'user') return block.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  const out: string[] = [];
  for (const item of block.items) {
    if (item.kind === 'part' && item.part.type === 'text') out.push(item.part.text);
  }
  return out.join('\n\n');
}

export type Block =
  | { kind: 'user'; key: string; at: number; parts: Part[] }
  | { kind: 'agent'; key: string; at: number; items: Item[] }
  | { kind: 'notice'; key: string; at: number; part: Extract<Part, { type: 'notice' }> };

/**
 * Consecutive assistant and tool entries form one agent turn; within a turn,
 * consecutive tool calls form one group. Tool results are not shown on their own:
 * they are folded into their call by id (see `results`).
 */
export function project(entries: Entry[]): Block[] {
  const blocks: Block[] = [];
  let turn: Extract<Block, { kind: 'agent' }> | null = null;
  for (const e of entries) {
    const notices = e.parts.filter((p): p is Extract<Part, { type: 'notice' }> => p.type === 'notice');
    const rest = e.parts.filter((p) => p.type !== 'notice' && p.type !== 'tool_result');
    notices.forEach((part, i) => {
      turn = null;
      blocks.push({ kind: 'notice', key: `${e.seq}.n${i}`, at: e.at, part });
    });
    if (!rest.length) continue;
    if (e.role === 'user') {
      turn = null;
      blocks.push({ kind: 'user', key: String(e.seq), at: e.at, parts: rest });
      continue;
    }
    if (!turn) {
      turn = { kind: 'agent', key: String(e.seq), at: e.at, items: [] };
      blocks.push(turn);
    }
    rest.forEach((part, i) => {
      const last = turn!.items.at(-1);
      if (part.type === 'tool_call') {
        if (last?.kind === 'tools') last.calls.push(part.call);
        else turn!.items.push({ kind: 'tools', key: `${e.seq}.${i}`, calls: [part.call] });
      } else {
        turn!.items.push({ kind: 'part', key: `${e.seq}.${i}`, part });
      }
    });
  }
  return blocks;
}

/**
 * Prose of the newest assistant turn. A trailing turn that only called tools
 * is skipped, so the last thing the agent actually said is what gets sent.
 */
export function lastAssistantText(entries: Entry[]): string {
  const blocks = project(entries);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.kind !== 'agent') continue;
    const text = blockText(block).trim();
    if (text) return text;
  }
  return '';
}

/**
 * The newest agent turn may have started before this page. A user message or
 * a notice earlier in the page means the turn is already whole.
 */
export function assistantTurnCutOff(entries: Entry[]): boolean {
  if (!entries.length) return false;
  const blocks = project(entries);
  let lastAgent = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === 'agent') {
      lastAgent = i;
      break;
    }
  }
  if (lastAgent < 0) return false;
  for (let i = 0; i < lastAgent; i++) {
    if (blocks[i].kind === 'user' || blocks[i].kind === 'notice') return false;
  }
  return true;
}

const ASSISTANT_PAGE = 200;
const ASSISTANT_PAGES = 5;
/** Prose sent to the subscription for a handoff summary. The latest reply is kept separately, in full. */
const TRANSCRIPT_BUDGET = 16_000;
const HANDOFF_PAGES = 8;

/** User and assistant prose, in order. Tool calls, results, and reasoning are left out. */
export function transcriptProse(entries: Entry[]): string {
  const out: string[] = [];
  for (const block of project(entries)) {
    const text = blockText(block).trim();
    if (!text) continue;
    if (block.kind === 'user') out.push(`User:\n${text}`);
    else if (block.kind === 'agent') out.push(`Assistant:\n${text}`);
    else out.push(text);
  }
  return out.join('\n\n');
}

/** Keep the end of a transcript so the newest turns survive a length cap. */
export function clipTail(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(trimmed.length - max);
  const breakAt = cut.indexOf('\n\n');
  return (breakAt >= 0 && breakAt < 400 ? cut.slice(breakAt + 2) : cut).trimStart();
}

/** What Send to… puts in the box: a subscription summary, the latest reply, or both. */
export function handoffText(summary: string, latest: string): string {
  const s = summary.trim();
  const l = latest.trim();
  if (s && l) return `Session summary:\n${s}\n\nLatest reply:\n${l}`;
  if (s) return `Session summary:\n${s}`;
  return l;
}

/**
 * Last assistant prose. Pages backward while the newest turn is cut off, or
 * while that turn has not spoken yet. Stops after a few pages so a long tool
 * run cannot walk the whole transcript.
 */
export async function readLastAssistant(page: (before: number, limit: number) => Promise<FeedPage>): Promise<string> {
  let before = Number.POSITIVE_INFINITY;
  let entries: Entry[] = [];
  for (let n = 0; n < ASSISTANT_PAGES; n++) {
    const got = await page(before, ASSISTANT_PAGE);
    if (!got.entries.length) break;
    entries = [...got.entries, ...entries];
    const text = lastAssistantText(entries);
    // A busy turn may not have spoken yet, so keep going until a reply is in hand
    // and that reply's turn starts inside the pages we have.
    if (!got.hasOlder || (!assistantTurnCutOff(entries) && text)) break;
    const oldest = got.entries[0].seq;
    if (!(oldest < before)) break;
    before = oldest;
  }
  return lastAssistantText(entries);
}

/**
 * Latest assistant reply, plus a clipped prose transcript of the recent
 * session for a subscription to summarize. Pages backward until that reply's
 * turn is whole and the transcript is full, and then stops.
 */
export async function readHandoff(page: (before: number, limit: number) => Promise<FeedPage>): Promise<{ latest: string; transcript: string }> {
  let before = Number.POSITIVE_INFINITY;
  let entries: Entry[] = [];
  for (let n = 0; n < HANDOFF_PAGES; n++) {
    const got = await page(before, ASSISTANT_PAGE);
    if (!got.entries.length) break;
    entries = [...got.entries, ...entries];
    const latest = lastAssistantText(entries);
    const prose = transcriptProse(entries);
    const whole = !assistantTurnCutOff(entries);
    if (!got.hasOlder || (whole && latest && prose.length >= TRANSCRIPT_BUDGET)) break;
    const oldest = got.entries[0].seq;
    if (!(oldest < before)) break;
    before = oldest;
  }
  return { latest: lastAssistantText(entries), transcript: clipTail(transcriptProse(entries), TRANSCRIPT_BUDGET) };
}
