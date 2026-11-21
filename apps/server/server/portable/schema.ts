// Portable conversations: ah's own versioned record of a conversation, independent
// of the harness that wrote it (docs/spec/13-conductor.md, "Portable conversations").
//
// The harness's transcript stays the authoritative source. A portable document is
// read from it (server/portable/extract.ts), never written back into it, and says
// exactly where every message came from (`source`, `Message.line`). It carries
// what the transcript shows: what was said, the tool calls and results, turn
// boundaries, models, attachments, summaries the harness itself wrote. It never
// carries what the transcript doesn't: a model's internal state, or reasoning
// (a model's own scratchpad is counted, not copied; see `limitations`).
//
// Types only, shared with the web bundle and mirrored by the native app; bump
// PORTABLE_VERSION (and features.portable) on any change a reader must know about.

export const PORTABLE_FORMAT = 'ah.portable-conversation';
export const PORTABLE_VERSION = 1;

export type PortableRole = 'user' | 'assistant' | 'tool' | 'system';

export type PortablePart =
  | { type: 'text'; text: string; truncated?: boolean }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown>; truncated?: boolean }
  | { type: 'tool_result'; callId: string; text: string; isError: boolean; truncated?: boolean }
  /** An image or file, stored beside the document (`attachments`), never inline. */
  | { type: 'attachment'; ref: string }
  /** A boundary the harness recorded: compaction, interruption, a note. */
  | { type: 'notice'; kind: 'compacted' | 'interrupted' | 'info'; text: string }
  /** An agent's generative-UI block (docs/gui.md), kept as the JSON it wrote. */
  | { type: 'widget'; widget: Record<string, unknown> };

export type PortableMessage = {
  /** Stable within the source: the harness's own id when it has one, else `<line>`. */
  id: string;
  /** Source line (1-based) this message was read from: the provenance of every part. */
  line: number;
  /** Turn number: a turn starts at each message the person typed. 0 before the first. */
  turn: number;
  role: PortableRole;
  at: number;
  model?: string;
  parts: PortablePart[];
  /** This message is an ah continuation handing context over (not the person typing). */
  handoff?: { linkId: string };
};

export type PortableAttachment = {
  id: string;
  kind: 'image' | 'file';
  mediaType?: string;
  bytes: number;
  sha256: string;
  /** Owner-only copy beside the document (images), or the file it named (uploads). Host-local. */
  path?: string;
  /** Message it arrived with. */
  messageId: string;
  name?: string;
};

/** A summary the harness itself wrote (compaction), kept verbatim. */
export type PortableSummary = { line: number; at: number; kind: 'compaction'; text: string };

/** A file the conversation's tools changed, by path (relative to `cwd` when inside it). */
export type PortableArtifact = { path: string; tool: string; changes: number; lastLine: number };

/** Something the document could not carry faithfully. Readers must show these, not hide them. */
export type Limitation = {
  code:
    | 'reasoning_omitted'
    | 'images_by_reference'
    | 'tool_output_truncated'
    | 'older_messages_dropped'
    | 'unparsed_lines'
    | 'partial_last_line'
    | 'format_unverified'
    | 'no_internal_state'
    | 'source_changed'
    | 'attachments_missing'
    | 'same_checkout'
    | 'subagents_omitted';
  message: string;
  count?: number;
};

export type PortableSource = {
  host: string;
  harness: string;
  /** Feed adapter that read it (server/feed/adapters). */
  adapter: string;
  harnessId: string;
  /** ah session uid, when ah ran it. */
  uid?: string;
  /** The transcript's path on `host`. Provenance only: not meaningful on another machine. */
  file: string;
  bytes: number;
  /** sha256 of the `bytes` read, so a reader can tell whether the source moved on since. */
  sha256: string;
  lines: number;
  mtime: number;
};

export type PortableConversation = {
  format: typeof PORTABLE_FORMAT;
  version: typeof PORTABLE_VERSION;
  /** ah's conversation identity: `pc-` + a hash of `harness:harnessId`, the same on every host. */
  id: string;
  title: string;
  cwd: string;
  project: { root: string | null; branch: string | null; head: string | null; remote: string | null };
  models: string[];
  createdAt: number;
  updatedAt: number;
  extractedAt: number;
  source: PortableSource;
  messages: PortableMessage[];
  summaries: PortableSummary[];
  attachments: PortableAttachment[];
  artifacts: PortableArtifact[];
  /** The conversations this one continues, nearest first (server/portable/store.ts). */
  lineage: LineageRef[];
  limitations: Limitation[];
  stats: {
    messages: number;
    turns: number;
    toolCalls: number;
    reasoningOmitted: number;
    unparsedLines: number;
    /** Messages before this line were left out to stay within the size bound. */
    droppedBefore: number | null;
  };
};

/** How one conversation came from another. Guarantees differ: see `Strategy`. */
export type LinkKind = 'resume' | 'fork' | 'portable' | 'migration' | 'import';

/**
 * What a continuation transfers:
 *  - `native-resume`: the same conversation, resumed by its own harness. Exact.
 *  - `native-fork`: a copy under a new id in the same harness, which re-reads it. Exact.
 *  - `ancestor-fork`: back to a harness this lineage started in: that conversation is
 *    copied natively as it was at the branch point, and what happened since in the other
 *    harnesses is handed over as a reconstructed record. Exact up to the branch, then text.
 *  - `context-handoff`: a fresh session primed with a bounded reconstructed record and
 *    pointers to the full document. Nothing of the source model's internal state transfers.
 *  - `transfer`: the native transcript moved to another host (server/migrate).
 */
export type Strategy = 'native-resume' | 'native-fork' | 'ancestor-fork' | 'context-handoff' | 'transfer';

export type LinkState = 'preparing' | 'launching' | 'delivering' | 'linked' | 'failed' | 'cancelled';

export type LineageRef = {
  linkId: string;
  kind: LinkKind;
  strategy: Strategy;
  conversationId: string;
  harness: string;
  title: string;
  uid: string | null;
  /** Where in that conversation this one branched off (its line), when known. */
  checkpointLine: number | null;
  at: number;
};
