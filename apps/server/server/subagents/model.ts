// Subagents: the agents a session's agent spawned, shown as sessions of their own under
// it. The harness keeps everything that matters on disk (Claude Code writes each child's
// transcript beside its parent's, with a sidecar naming its parent and the call that
// spawned it; Codex writes each spawned thread as a rollout naming its parent thread), so
// ah persists nothing: a child's identity is a function of the harness's own ids, and any
// number of reads, restarts or reconnects arrives at the same tree. This module is the
// pure part: identities, lifecycle rules, the tree's order and its summary.

export type Harness = 'claude' | 'codex' | 'gemini' | 'grok' | 'hermes' | 'muse' | 'opencode';

/**
 * Where a child is in its life, as far as its transcripts tell.
 * `waiting`: its own work is done, but agents it spawned still run.
 * `unknown`: no outcome was ever recorded and nothing shows it still running (the
 * process that ran it is gone, or restarted since): not proof that it stopped.
 */
export type Lifecycle = 'running' | 'waiting' | 'completed' | 'failed' | 'canceled' | 'unknown';

/** What a client may do with a child. Only what ah can carry out for that harness, verified. */
export type Capabilities = {
  /** Its conversation can be read (GET /api/sessions/:ref/feed…). */
  transcript: boolean;
  /** It's working now: its feed is worth following. */
  live: boolean;
  /** A message can go to it alone. No harness lets a supervisor reach one child of a running agent. */
  send: boolean;
  /** It alone can be stopped. Same: only the parent agent (or its own UI) can. */
  cancel: boolean;
  /** It can go on as a session of its own (POST /api/sessions/:ref/resume): a finished Codex thread under an ended tree. */
  continue: boolean;
};

export type SubagentView = {
  /** ah's ref for it, accepted wherever a session ref is: `claude:<session>:<agent>` or `codex:<thread>`. */
  ref: string;
  harness: Harness;
  /** The harness's own id for it: Claude's agent id, Codex's thread id. */
  agentId: string;
  /** Its parent's ref: the root conversation (`harness:id`) or another child. */
  parentRef: string;
  rootRef: string;
  /** 1 under the root, 2 under a child of it… */
  depth: number;
  /** What it was asked to do, in a few words (the task's description, or the agent's nickname). */
  name: string;
  /** Its kind of agent (Claude's agent type, Codex's role), when the harness names one. */
  role: string | null;
  /** The start of the instructions it was given. */
  prompt: string | null;
  state: Lifecycle;
  /** Started in the background: the parent went on working meanwhile. */
  background: boolean;
  /** Seconds since the epoch. */
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  /** One line of what it's doing or did last: a tool call, or its last words. */
  activity: string | null;
  /** The parent's tool call that spawned it, when the harness records one (opens it from the parent's transcript). */
  toolCallId: string | null;
  capabilities: Capabilities;
};

/** The root a tree hangs from, as a client opens it. */
export type SubagentRoot = {
  /** `harness:id`, the conversation's ref. */
  ref: string;
  /** Its live window's uid, while it runs. */
  uid: string | null;
  title: string;
  live: boolean;
};

export type SubagentTree = { root: SubagentRoot; nodes: SubagentView[] };

/** What a session row carries: enough for a count, and `rev` to know the tree changed. */
export type SubagentSummary = {
  /** Every descendant, nested ones too. */
  total: number;
  /** Running or waiting on its own children. */
  active: number;
  completed: number;
  /** Failed or canceled. */
  failed: number;
  /** Changes whenever anything in the tree does (a child, a state, its activity). */
  rev: string;
};

// ---------- identity

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Claude agent ids: `a` + 16 hex in 2.1; kept loose for other versions, but never a path. */
const AGENT = /^[A-Za-z0-9_-]{1,48}$/;
/** Codex thread ids are UUIDs (v7). */
const THREAD = /^[A-Za-z0-9-]{1,64}$/;

export const isAgentId = (id: string) => AGENT.test(id);
export const isThreadId = (id: string) => THREAD.test(id);
export const isSessionId = (id: string) => UUID.test(id);

export function claudeRef(sessionId: string, agentId: string): string {
  return `claude:${sessionId}:${agentId}`;
}

/** A Claude child's ref, or null. Codex children are `codex:<thread>`, like any Codex conversation. */
export function parseClaudeRef(ref: string): { sessionId: string; agentId: string } | null {
  const m = /^claude:([^:]+):([^:]+)$/.exec(ref);
  return m && UUID.test(m[1]) && AGENT.test(m[2]) ? { sessionId: m[1], agentId: m[2] } : null;
}

// ---------- lifecycle

/** What the parent's transcript recorded about one Claude child. */
export type ClaudeOutcome =
  /** The spawning call's result: inline for a foreground child, an acknowledgement for a background one. */
  | { kind: 'result'; status: string | null; isError: boolean; interrupted: boolean; at: number }
  /** A background child's task notification (`<status>`). It can repeat when the child is continued. */
  | { kind: 'notification'; status: string; at: number };

/** What a child's own transcript ends with. */
export type TailFacts = {
  /** Its last line's time (seconds). */
  lastAt: number;
  /** Its last assistant message ended the turn (no tool call pending). */
  final: boolean;
  /** Its last word was an error from the provider. */
  error: boolean;
  /** Its last word was an interruption. */
  interrupted: boolean;
  activity: string | null;
};

/** Is the process that would run it still there, and since when (seconds)? */
export type Liveness = { live: boolean; since: number };

/** Children last written this long before their root's process started belong to an earlier run. */
const RESTART_SLOP = 30;

/**
 * A Claude child's state. The parent's record wins (it is what the parent agent was
 * told); then the child's own last words; then whether anything could still be running it.
 */
export function claudeState(o: { background: boolean; outcomes: ClaudeOutcome[]; tail: TailFacts | null; root: Liveness; runningChildren: number }): { state: Lifecycle; endedAt: number | null } {
  const result = o.outcomes.filter((x) => x.kind === 'result').at(-1);
  const note = o.outcomes.filter((x) => x.kind === 'notification').at(-1);
  // A notification is newer than the launch acknowledgement; for a continued child a later result is newer still.
  const last = [result, note].filter((x): x is ClaudeOutcome => !!x).sort((a, b) => a.at - b.at).at(-1);
  const wait = (ended: { state: Lifecycle; endedAt: number | null }) => (ended.state === 'completed' && o.runningChildren > 0 ? { state: 'waiting' as const, endedAt: null } : ended);
  if (last?.kind === 'notification') return wait(fromStatus(last.status, last.at));
  if (last?.kind === 'result') {
    if (last.interrupted) return { state: 'canceled', endedAt: last.at };
    if (last.isError) return { state: 'failed', endedAt: last.at };
    // A background child's acknowledgement says only that it started.
    const launched = o.background || last.status === 'async_launched';
    if (!launched) return wait({ state: 'completed', endedAt: last.at });
  }
  return fromTail(o.tail, o.root, o.runningChildren);
}

function fromStatus(status: string, at: number): { state: Lifecycle; endedAt: number | null } {
  const s = status.toLowerCase();
  if (s === 'completed' || s === 'complete' || s === 'success') return { state: 'completed', endedAt: at };
  if (s === 'failed' || s === 'error' || s === 'errored') return { state: 'failed', endedAt: at };
  if (/^(killed|stopped|cancel|interrupt|shutdown|aborted)/.test(s)) return { state: 'canceled', endedAt: at };
  return { state: 'unknown', endedAt: null };
}

/** No outcome on record: its own transcript, then whether anything could still run it. */
function fromTail(tail: TailFacts | null, root: Liveness, runningChildren: number): { state: Lifecycle; endedAt: number | null } {
  if (tail?.interrupted) return { state: 'canceled', endedAt: tail.lastAt };
  // Written since its root's process started: that process runs it, and its parent is told
  // when it ends. Its own last words don't say so: a text line is written before the tool
  // call that follows it in the same message, with no stop reason on either.
  if (root.live && (!tail || tail.lastAt >= root.since - RESTART_SLOP)) return { state: 'running', endedAt: null };
  // Nothing will write to it any more: what it ended on is what it did.
  if (tail?.final) return runningChildren > 0 ? { state: 'unknown', endedAt: null } : { state: 'completed', endedAt: tail.lastAt };
  if (tail?.error) return { state: 'failed', endedAt: tail.lastAt };
  return { state: 'unknown', endedAt: null };
}

/** The turn events a Codex thread records, newest last. */
export type CodexTurn = { kind: 'started' | 'complete' | 'aborted' | 'error'; at: number };

/**
 * A Codex child's state, from its own rollout: each turn starts and completes (or is
 * aborted) there. A completed thread can be given more work by its parent later, which
 * starts a new turn: it is running again.
 */
export function codexState(o: { last: CodexTurn | null; tail: TailFacts | null; root: Liveness; runningChildren: number }): { state: Lifecycle; endedAt: number | null } {
  switch (o.last?.kind) {
    case 'complete':
      return o.runningChildren > 0 ? { state: 'waiting', endedAt: null } : { state: 'completed', endedAt: o.last.at };
    case 'aborted':
      return { state: 'canceled', endedAt: o.last.at };
    case 'error':
      return o.root.live ? { state: 'running', endedAt: null } : { state: 'failed', endedAt: o.last.at };
  }
  const lastAt = Math.max(o.tail?.lastAt ?? 0, o.last?.at ?? 0);
  if (o.root.live && lastAt >= o.root.since - RESTART_SLOP) return { state: 'running', endedAt: null };
  return { state: 'unknown', endedAt: null };
}

export const isActive = (s: Lifecycle) => s === 'running' || s === 'waiting';

/** A Gemini child's place, from agy's summary: killed, idle, or still running with its parent. */
export function geminiState(o: { killed?: boolean; idle?: boolean; endedAt?: number; updatedAt: number; root: Liveness }): { state: Lifecycle; endedAt: number | null } {
  if (o.killed) return { state: 'canceled', endedAt: o.endedAt || o.updatedAt || null };
  if (o.idle) return { state: 'completed', endedAt: o.endedAt || o.updatedAt || null };
  if (o.root.live && o.updatedAt >= o.root.since - RESTART_SLOP) return { state: 'running', endedAt: null };
  return { state: 'unknown', endedAt: null };
}

/** `gemini:<conversation id>`, and nothing else. */
export function parseGeminiRef(ref: string): string | null {
  if (!ref.startsWith('gemini:')) return null;
  const id = ref.slice('gemini:'.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : null;
}

export function capabilities(harness: Harness, state: Lifecycle, rootLive: boolean): Capabilities {
  return {
    transcript: true,
    live: isActive(state) && rootLive,
    send: false,
    cancel: false,
    // `codex resume <thread>` carries a spawned thread on as a conversation of its own
    // (verified with 0.162.1). Not while its tree runs: its parent may still write to it.
    continue: harness === 'codex' && !isActive(state) && !rootLive,
  };
}

// ---------- the tree

/**
 * Parents before their children, siblings by when they started; a child whose parent
 * isn't known (its sidecar named one that never showed up) hangs from the root, so
 * nothing found is ever hidden. Each node's depth is recomputed from where it ends up.
 */
export function orderTree(nodes: SubagentView[], rootRef: string): SubagentView[] {
  const byRef = new Map(nodes.map((n) => [n.ref, n]));
  const kids = new Map<string, SubagentView[]>();
  for (const n of nodes) {
    const parent = n.parentRef !== n.ref && byRef.has(n.parentRef) ? n.parentRef : rootRef;
    (kids.get(parent) ?? kids.set(parent, []).get(parent)!).push(n);
  }
  // Stable: siblings that started in the same second keep the order they came in (finer than a second).
  for (const list of kids.values()) list.sort((a, b) => a.startedAt - b.startedAt);
  const out: SubagentView[] = [];
  const seen = new Set<string>();
  const walk = (ref: string, depth: number) => {
    for (const n of kids.get(ref) ?? []) {
      if (seen.has(n.ref)) continue; // a cycle in what the harness wrote never loops
      seen.add(n.ref);
      out.push(n.depth === depth && (n.parentRef === ref) ? n : { ...n, depth, parentRef: ref });
      walk(n.ref, depth + 1);
    }
  };
  walk(rootRef, 1);
  // What a cycle cut off is still shown, under the root.
  for (const n of nodes) if (!seen.has(n.ref)) out.push({ ...n, depth: 1, parentRef: rootRef });
  return out;
}

/** How many of each node's descendants are active, for `waiting`. */
export function runningBelow(nodes: { ref: string; parentRef: string; active: boolean }[]): Map<string, number> {
  const parent = new Map(nodes.map((n) => [n.ref, n.parentRef]));
  const counts = new Map<string, number>();
  for (const n of nodes) {
    if (!n.active) continue;
    const seen = new Set<string>();
    for (let p = parent.get(n.ref); p && !seen.has(p); p = parent.get(p)) {
      seen.add(p);
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  return counts;
}

export function summarize(nodes: SubagentView[]): SubagentSummary {
  let active = 0;
  let completed = 0;
  let failed = 0;
  let h = 0x811c9dc5;
  for (const n of nodes) {
    if (isActive(n.state)) active++;
    else if (n.state === 'completed') completed++;
    else if (n.state === 'failed' || n.state === 'canceled') failed++;
    for (const s of [n.ref, n.state, n.activity ?? '', n.name, String(n.updatedAt)]) {
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
      h = Math.imul(h ^ 0x1f, 0x01000193);
    }
  }
  return { total: nodes.length, active, completed, failed, rev: (h >>> 0).toString(36) };
}

/** One line, plain, clipped: for a name, a prompt or an activity. */
export function line(text: unknown, max = 120): string | null {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}
