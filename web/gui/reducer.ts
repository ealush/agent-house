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

export type Action = FeedMessage | ({ type: 'older' } & FeedPage) | { type: 'disconnected' };

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
    case 'disconnected':
      return s.status === 'live' ? { ...s, status: 'connecting' } : s;
  }
}

// ---------- projection: entries → blocks the timeline renders

export type Item = { kind: 'part'; key: string; part: Part } | { kind: 'tools'; key: string; calls: ToolCall[] };

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
