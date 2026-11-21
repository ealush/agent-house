// The GUI's event vocabulary: every harness's structured transcript is normalized
// into these types by one adapter per harness (server/feed/adapters/*), and the web
// GUI (web/gui) renders only these. Nothing downstream knows which agent wrote them.
//
// Types only: the web bundle imports this file with `import type`.

/** One source record (a transcript line) → one entry. `seq` is its line number. */
export type Entry = {
  /** Monotonic per transcript and the only ordering authority. Sparse: lines that
   *  carry nothing renderable are skipped. */
  seq: number;
  /** Stable id from the source when it has one, else `seq` as a string. */
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** What produced it, for trajectory reconstruction. */
  step: 'message' | 'llm_call' | 'tool_execution' | 'observation';
  at: number;
  parts: Part[];
};

export type Part =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'media'; kind: 'image'; src: string; alt?: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'widget'; widget: Widget }
  /** A conversation boundary the harness recorded (compaction, interruption). */
  | { type: 'notice'; kind: 'compacted' | 'interrupted' | 'info'; text: string };

/** A tool call as a first-class object. The result arrives later as its own part
 *  and the client reducer folds it in by `id`. */
export type ToolCall = {
  id: string;
  name: string;
  /** Parsed arguments when they were JSON, else `{ input: <raw string> }`. */
  args: Record<string, unknown>;
};

export type ToolResult = {
  callId: string;
  /** What the model saw, as text (truncated for transport). */
  text: string;
  isError: boolean;
  /** Harness-provided structure beyond the text, e.g. a file patch. */
  data?: Record<string, unknown>;
  images?: string[];
  truncated?: boolean;
};

/**
 * Generative UI: an agent writes a fenced ```ah-widget block holding one JSON object
 * with a `type`. Unknown types are kept as-is and rendered generically; nothing is
 * invented. See docs/gui.md for the vocabulary agents are told about.
 */
export type Widget = { type: string; [key: string]: unknown };

/** Server → client stream messages (SSE event name = `type`). */
export type FeedMessage =
  /** Sent first, and again whenever the projection must be rebuilt from scratch. A `resume`
   *  (asked for with `?after=`) is the entries after the viewer's own copy instead: it
   *  appends to what the viewer holds rather than replacing it. */
  | { type: 'snapshot'; reason: 'initial' | 'rotated' | 'truncated' | 'resume'; harness: string; entries: Entry[]; floor: number; head: number; hasOlder: boolean }
  | { type: 'append'; entries: Entry[]; head: number }
  /** No transcript to read (yet): a fresh session, or a harness without an adapter. */
  | { type: 'unavailable'; reason: 'no-adapter' | 'no-transcript' | 'not-found' };

/** GET /feed?before=seq: one page of older entries. */
export type FeedPage = { entries: Entry[]; hasOlder: boolean };

/** GET /feed/prompts: every message you sent (each one the GUI draws as your bubble), oldest first. */
export type FeedPrompt = { seq: number; at: number; text: string };
