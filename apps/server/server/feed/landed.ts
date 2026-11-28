// Whether a message ah typed reached the agent: read from its conversation, through the
// same adapters as the chat view, so every harness with a feed is confirmed the same way
// (a JSONL transcript, a JSON document, a SQLite store), never from its screen.
import { open, stat } from 'node:fs/promises';
import { IMAGE_PATH } from '../imagePaths.ts';
import { ADAPTERS, DOC_ADAPTERS } from './feed.ts';
import { isLinkHint } from '../sessionLinks.ts';
import type { Entry } from './schema.ts';

/**
 * Where a conversation ended the moment before ah typed into it: a line transcript's
 * `size`, a document's last entry `seq`. `file` is null when the agent hasn't written one
 * yet (a new session's first prompt): then whatever it writes from `at` on is after the mark.
 */
export type ConversationMark = { adapter: string; file: string | null; size: number; seq: number; at: number };

/** Adapters whose conversations can be read: every harness with a feed. */
export const confirms = (adapter: string | undefined): adapter is string => !!adapter && (!!ADAPTERS[adapter] || !!DOC_ADAPTERS[adapter]);

/** Marks where the conversation in `file` (null: not written yet) ends now. */
export async function markConversation(adapter: string, file: string | null): Promise<ConversationMark> {
  const at = Date.now();
  if (!file) return { adapter, file: null, size: 0, seq: 0, at };
  if (ADAPTERS[adapter]) return { adapter, file, size: (await stat(file).catch(() => null))?.size ?? 0, seq: 0, at };
  const entries = await DOC_ADAPTERS[adapter]!(file).catch(() => null);
  return { adapter, file, size: 0, seq: entries?.at(-1)?.seq ?? 0, at };
}

/**
 * Whether the conversation, now in `file`, has a message from the user saying `text`
 * after `mark`. When it can't be told (the transcript was rewritten under the mark),
 * it says yes: what can't be confirmed is never typed twice.
 */
export async function conversationHas(mark: ConversationMark, file: string, text: string): Promise<boolean> {
  const needle = needleFor(text);
  if (!needle) return true;
  return said(await entriesAfter(mark, file), needle);
}

async function entriesAfter(mark: ConversationMark, file: string): Promise<Entry[] | null> {
  const parse = ADAPTERS[mark.adapter];
  if (parse) {
    const known = mark.file === file;
    const s = await stat(file).catch(() => null);
    if (!s) return [];
    if (known && s.size < mark.size) return null;
    const from = known ? mark.size : 0;
    if (s.size - from > LANDED_READ) return null;
    if (s.size === from) return [];
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(s.size - from);
      const { bytesRead } = await fh.read(buf, 0, buf.length, from);
      const out: Entry[] = [];
      for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = parse(JSON.parse(line), out.length + 1);
          if (e) out.push(e);
        } catch {}
      }
      return known ? out : out.filter(after(mark));
    } finally {
      await fh.close();
    }
  }
  const entries = await DOC_ADAPTERS[mark.adapter]?.(file).catch(() => null);
  if (!entries) return [];
  // What's new is past the mark's seq, never past a count: a document's older entries can
  // stop showing (agy blanks the replies it has compacted away), and counting would skip
  // as many new ones. One that ends before the mark was rewritten, so its own clock says
  // what came after.
  const last = entries.at(-1)?.seq ?? 0;
  return mark.file === file && last >= mark.seq ? entries.filter((e) => e.seq > mark.seq) : entries.filter(after(mark));
}

/**
 * Whether an entry of a conversation ah had no file for at the mark came after it, by the
 * entry's own clock. One with no time (Grok's transcript stamps none) can't be placed: it
 * counts, so a first prompt there is found rather than shown as not sent (never typed twice).
 */
const after = (mark: ConversationMark) => (e: Entry) => !e.at || e.at >= mark.at - CLOCK_SLACK_MS;

/** Null: unreadable, so taken as said (never typed twice). */
function said(entries: Entry[] | null, needle: string): boolean {
  if (!entries) return true;
  return entries.some((e) => e.role === 'user' && squash(e.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(' ')).includes(needle));
}

/**
 * What to look for in the conversation to know `text` arrived: its longest line, image
 * paths left out (an agent swaps a pasted picture's path for its own token), with no
 * whitespace (agents re-wrap and trim). Null when nothing's left to tell it by.
 */
export function needleFor(text: string): string | null {
  // Never the line ah put after a session's link: transcripts are read without it (feed.ts).
  const lines = text.split(IMAGE_PATH).flatMap((piece) => piece.split('\n')).map((l) => l.trim()).filter((l) => !isLinkHint(l));
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), '');
  return longest.length >= 4 ? squash(longest).slice(0, 60) : null;
}

const squash = (s: string) => s.replace(/\s+/g, '');

/** More than this after the mark and the prompt is surely in there (it lands at the start). */
const LANDED_READ = 64 << 20;
/** An agent stamps its own entries; this much earlier than ah's mark still counts as after. */
const CLOCK_SLACK_MS = 2000;
