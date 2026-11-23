import type { FeedPage, FeedPrompt } from '../server/feed/schema.ts';
import type { SubagentSummary, SubagentTree } from '../server/subagents/model.ts';
import type { CheckoutsOverview, CheckoutsState, CheckoutView, GcRunResult } from '../server/checkouts/model.ts';
import { clientLog, messageDetail } from './clientLog.ts';
import { reachText } from './errors.ts';
import type { NoteDTO, NoteProject, NotesPage, NotesState } from './notes.ts';

export type { CheckoutsOverview, CheckoutView, CheckoutsState, GcRunResult };

export type Status = 'busy' | 'idle' | 'waiting' | 'attention';
export type AttachedTerminal = { id: string; cwd: string; command: string; busy: boolean };

export type Win = {
  terminal?: AttachedTerminal | null;
  id: string;
  /** Added client-side: which machine, and a selection key unique across machines. */
  host: string;
  key: string;
  session: string;
  index: number;
  name: string;
  title: string;
  uid: string;
  agent: string | null;
  harnessId: string | null;
  model: string | null;
  statusSource: 'hook' | 'screen' | 'activity';
  command: string;
  cwd: string;
  project: string;
  projectPath: string;
  branch: string | null;
  worktree: boolean;
  status: Status;
  detail: string | null;
  /** The agent hit its usage limit: "Session limit · resets 12am". */
  limit?: string | null;
  ask: Ask | null;
  answerable: boolean;
  viewers: number;
  devices: string[];
  activity: number;
  /** The last thing said in its conversation; `at` in milliseconds. Absent until read, and for agents without a transcript. */
  reply?: { role: 'assistant' | 'user'; text: string; at: number } | null;
  createdAt: number;
  panes: number;
  pinned: boolean;
  queued: number;
  /** Messages typed in that the agent never took (listed first in its queue). */
  unsent: number;
  order: number | null;
  launch: string | null;
  launchModel: string | null;
  launchEffort: string | null;
  launchMode: string | null;
  /** Set when the agent's transcript can drive the GUI view. */
  feed: string | null;
  /** Fork lineage (F36): this session is a fork, and how many forks it has. */
  fork: { parentUid: string; parentTitle: string; rootUid: string; forks: number } | null;
  /** Portable lineage: the conversation this one continues (another agent's, a fork, another host's). */
  continued?: Continued | null;
  /** The agents its agent spawned, counted over the whole tree (server/subagents); absent for agents ah reads none of. */
  subagents?: SubagentSummary | null;
  /** Something went wrong and ah is (or could be) keeping it going (server/recovery). */
  recovery?: Recovery | null;
};

export type ForkInfo = {
  canFork: boolean;
  reason: string | null;
  harness: string;
  title: string;
  suggestedName: string;
  branch: string | null;
  head: string | null;
  dirty: number;
  busy: boolean;
  mode: string | null;
  model: string | null;
  effort: string | null;
  dangerous: boolean;
};

export type ForkResult = {
  uid: string;
  id: string;
  harnessId: string;
  worktree: string;
  branch: string;
  base: string;
  prompt: 'delivered' | 'queued' | null;
};

export type Question = {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
};
export type QuestionAnswer = { picked: number[]; text?: string };
/** Settings → System → Developer: the host's log (server/devlog.ts). */
export type LoggingStatus = { server: boolean; dir: string; keepDays: number; days: Array<{ day: string; files: Array<{ name: string; bytes: number }> }> };
/** A device's log bundle as the host keeps it. */
export type ClientBundle = { client: { app: string; device: string; version: string; build: string; os: string }; note?: string; entries: Array<Record<string, unknown>> };
export type DesktopStatus = { installed: boolean; omarchy: boolean; url: string; file: string; bind: string };

/** Settings → Agents: an agent this host knows, and what its CLI said when last asked (server/harnesses.ts). */
export type HarnessInfo = {
  id: string;
  name: string;
  command: string;
  custom: boolean;
  installed: boolean;
  hidden: boolean;
  version: string | null;
  checkedAt: number | null;
  changes: string[];
};
export type Harnesses = { agents: HarnessInfo[]; suggestions: Array<{ command: string; name: string }> };

export type HooksStatus = {
  claude: { wired: number; of: number; file: string };
  codex: { wired: boolean; otherNotify: boolean; file: string };
  /** Per harness: prompts its hooks reported, and how many the screen rules missed (server/audit.ts). */
  audit?: Record<string, { checked: number; missed: number; last?: { at: number; ask: string; screen: string } }>;
};
export type SlashCommand = { name: string; description: string; source: 'built-in' | 'project' | 'user' | 'skill' };
export type Ask = {
  kind: 'command' | 'tool' | 'question' | 'screen' | 'choice';
  text: string;
  /** `choice`: the agent's multiple-choice questions, when its hook reported them. */
  questions?: Question[];
  /** Rows of a numbered picker on screen; `key` is what gets typed, `description` the line under it. */
  options?: Array<{ key: string; label: string; description?: string }>;
  /** The one question the dialog shows now, when the whole set isn't known or it's half answered. */
  dialog?: { question: string; multiSelect: boolean; options: Array<{ label: string; description?: string; checked?: boolean }>; total: number; answered: number };
  /** A screen in front of the agent's prompt (server/agentgate.ts): a message waits until it's answered. */
  gate?: Gate;
};

/** What the screen in front of an agent's prompt wants: to trust its folder, to sign in, setup. */
export type Gate = {
  kind: 'trust' | 'signin' | 'setup';
  /** Links on the screen, whole. */
  links?: string[];
  /** A one-time code to enter on another page. */
  code?: string;
  /** It takes typed text (a code pasted back, an API key): the line that asks for it. */
  input?: string;
  /** Its sign-in link returns to 127.0.0.1 on the agent's host: only a browser there finishes it. */
  local?: boolean;
  /** Where that link hands back to ("http://127.0.0.1:1455/auth/callback"): the address a browser elsewhere stops on can be pasted back. */
  callback?: string;
  /** Esc goes back a step (or cancels), as the screen says. */
  back?: boolean;
};

export type HistoryItem = {
  ref: string;
  host: string;
  kind: 'ended' | 'saved';
  harness: string;
  harnessId: string | null;
  title: string;
  cwd: string;
  project: string;
  model: string | null;
  at: number;
  pinned: boolean;
  worktree: string | null;
  /** Fork lineage (F36): the title of the session this one was forked from. */
  fork: { parentTitle: string } | null;
  continued?: Continued | null;
  /** Moved to another host: it goes on there. */
  moved?: { host: string; uid: string; at: number } | null;
  /** Cut off, not ended: the tmux server stopped, the host restarted, or its window closed mid-turn (server/interruptions). */
  interrupted?: Interrupted | null;
};

export type InterruptCause = 'tmux_server' | 'host_restart' | 'window';
export type Interrupted = { cause: InterruptCause; at: number; lastSeenAt: number; incident: string; lastStatus: string; midTurn: boolean };
export type InterruptionsState = { count: number; midTurn: number; incidents: Array<{ id: string; cause: InterruptCause; at: number; count: number; midTurn: number }> };
export type Restored = { uid: string; windowId: string; resumed: boolean; noted: boolean; midTurn: boolean };
/** Which interrupted sessions an action is for: some, one incident, or all of them. */
export type InterruptTarget = { uids: string[] } | { incident: string } | { all: true };

export type PresetChoice = { id: string; name: string; args?: string[]; dangerous?: boolean; description?: string; appliesTo?: string };
export type ModelChoice = { id: string; name: string; args: string[]; appliesTo?: string; description?: string; efforts?: string[]; isDefault?: boolean };
export type Preset = {
  id: string;
  name: string;
  command: string;
  resume?: string;
  modes?: PresetChoice[];
  models?: ModelChoice[];
  effort?: { levels: string[] };
  /** The harness's own defaults, from its config (catalog). */
  defaultModel?: string;
  defaultEffort?: string;
  /** Present when the agent can switch model / effort mid-session. */
  switchModel?: string;
  switchEffort?: string;
  /** Present when the agent has a command back to its own default. */
  resetModel?: string;
  resetEffort?: string;
  /** Present when the agent switches permission mode live. */
  modeCycle?: { key: string };
  modelArgs?: string[];
  settingsCommands?: { model?: string; effort?: string; mode?: string };
  /** Transcript adapter for the GUI view; absent for terminal-only presets. */
  feed?: string;
  available: boolean;
  /** Kept out of New session on this host (Settings → Agents). */
  hidden?: boolean;
};

export type Host = { name: string; self: boolean; online: boolean };

export const API_VERSION = 28;

export type PullInfo = { number: number | null; url: string | null };

export type Subscription = { id: string; name: string; baseUrl: string; model: string; hasKey: boolean; keyHint: string; isDefault: boolean; envName: string | null };
/** Settings → Environment: what new session windows start with (server/env.ts). */
export type EnvVar = { name: string; value: string | null; secret: boolean; hint: string | null };
export type EnvState = {
  vars: EnvVar[];
  exports: { name: string; subscriptionId: string; subscription: string }[];
  /** Running agent sessions on older values; restart is null when it can go ahead now. */
  stale: { uid: string; title: string; agent: string; restart: string | null }[];
};
export type ChatMsg = { role: 'user' | 'assistant'; text: string; at: number; id?: number };

/** Full-text search (issue #9): one grouped hit per session or chat. */
export type SearchExcerpt = { seq: number | null; msgId: number | null; role: string; at: number; snippet: string };
export type SearchHit = {
  kind: 'transcript' | 'chat';
  host: string;
  ref: string | null;
  uid: string | null;
  harness: string | null;
  harnessId: string | null;
  title: string;
  cwd: string;
  at: number;
  matches: number;
  excerpts: SearchExcerpt[];
};
export type SearchResponse = {
  enabled: boolean;
  building: boolean;
  results: SearchHit[];
  total: number;
  tookMs: number;
  notes: Array<{ host: string; error: string }>;
};
export type SearchStatus = {
  enabled: boolean;
  building: boolean;
  sourcesIndexed: number;
  sourcesKnown: number;
  entries: number;
  transcriptEntries: number;
  chatEntries: number;
  lastBuiltAt: number;
};
export type SearchQuery = { q: string; scope?: string; role?: string; project?: string; host?: string; model?: string; limit?: number; offset?: number; from?: number; to?: number };
export type ChatSummary = { uid: string; title: string; count: number; firstAt: number; lastAt: number; preview: string };
export type Followup = { title: string; kind: 'session' | 'chat'; text: string };
export type ChatReply = { message: ChatMsg; followups: Followup[] };

/** A session's recovery from a limit, a provider error or a crash (server/recovery). */
export type Recovery = { state: 'waiting_capacity' | 'recoverable' | 'scheduled' | 'resuming' | 'needs_user' | 'failed' | 'stopped'; reason: string; evidence: string; attempts: number; maxAttempts: number; nextAttemptAt: number | null; resetsAt: number | null; auto: boolean; updatedAt: number };

/** Where a conversation came from when ah carried it over (server/sessions.ts `Continued`). */
export type Continued = { linkId: string; fromUid: string | null; fromHarness: string; fromTitle: string; fromHost?: string; kind: 'resume' | 'fork' | 'portable' | 'import' | 'migration'; strategy: string; at: number };

export type Limitation = { code: string; message: string; count?: number };

/** POST /api/portable/conversations/:ref/preview: what continuing elsewhere would transfer. */
export type ContinuePlan = {
  strategy: 'native-resume' | 'native-fork' | 'ancestor-fork' | 'context-handoff';
  kind: string;
  source: { ref: string; uid: string | null; harness: string; title: string; cwd: string; live: boolean; busy: boolean };
  destination: { harness: string; name: string; cwd: string; worktree: boolean; model?: string; effort?: string; mode?: string };
  transfers: string[];
  limitations: Limitation[];
  blocked: { code: string; message: string } | null;
  ancestor: { conversationId: string; harness: string; title: string; checkpointLine: number } | null;
  handoff: { chars: number; messagesIncluded: number; messagesOmitted: number; preview: string } | null;
};

/** Moving a stopped session to another host (server/migrate). */
export type MoveRequirement = { code: string; message: string; blocking: boolean };
export type MovePreview = { preflight: { ok: boolean; destCwd: string | null; resolvedBy: string | null; requirements: MoveRequirement[]; existing: string; host: string } };
export type Migration = { id: string; role: 'outgoing' | 'incoming'; state: string; peer: string; sourceUid: string | null; destUid: string | null; harness: string; title: string; sourceCwd: string; destCwd: string | null; error: string | null; createdAt: number; updatedAt: number };

/** A note handed to a session (server/notes/handoff.ts): `uncertain` is sent again only when asked. */
export type NoteHandoff = { id: string; noteId: string; revision: number; target: string; outcome: 'delivered' | 'queued' | 'uncertain' | 'failed'; queueId: string | null; resumed: boolean; error: string | null; replay: boolean; at: number };

/** Scheduled work (server/jobs): what a job does and when; one run of it. */
export type JobAction =
  | { kind: 'launch'; preset: string; cwd: string; prompt: string; name?: string; model?: string; effort?: string; mode?: string; worktree?: boolean }
  | { kind: 'send'; target: string; text: string }
  | { kind: 'decide'; title: string; body?: string; then?: { kind: 'launch' | 'send'; [k: string]: unknown } };
export type JobTrigger = { kind: 'at'; at: number } | { kind: 'cron'; expr: string; tz: string } | { kind: 'after'; job: string; on: 'success' | 'failure' | 'any' } | { kind: 'session'; uid: string; on: 'idle' | 'ended' } | { kind: 'manual' };
export type JobRun = { id: string; jobId: string; seq: number; state: string; triggeredBy: string; scheduledFor: number; attempt: number; sessionUid: string | null; delivery: Record<string, unknown>; outcome: { reply?: string; body?: string; decision?: string; skippedBecause?: string }; error: string | null; startedAt: number | null; endedAt: number | null; createdAt: number };
export type Job = { id: string; name: string; state: string; action: JobAction; trigger: JobTrigger; policy: Record<string, unknown>; nextRunAt: number | null; runCount: number; createdAt: number; updatedAt: number; lastRun: JobRun | null };
export type JobsState = { next: Array<{ id: string; name: string; at: number }>; running: Array<{ id: string; name: string; runId: string; sessionUid: string | null }>; waiting: Array<{ id: string; name: string; runId: string; title: string; body: string }>; uncertain: Array<{ id: string; name: string; runId: string }> };

/** Usage (server/usage): one grouped row; tokens are local telemetry, cost an estimate. */
export type UsageRow = {
  key: string;
  provider: string | null;
  harness: string | null;
  model: string | null;
  uid: string | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; source: 'local_telemetry' };
  messages: number;
  sessions: number;
  cost: { estimateUsd: number | null; basis: string | null; unpricedTokens: number; billing: string | null };
};
export type UsageReport = { from: string; to: string; by: string; rows: UsageRow[]; notes: { tokens: string; cost: string; listPricesAsOf: string } };
export type UsageLimits = {
  windows: Array<{ harness: string; provider: string; window: string; usedPercent: number | null; windowMinutes: number | null; resetsAt: number | null; source: string; observedAt: number }>;
  cooldowns: Array<{ harness: string; uid: string; resetsAt: number | null; source: 'screen' | 'transcript'; text: string }>;
};

/** One continuation (a lineage edge) and how far it got. */
export type ContinueOp = { id: string; kind: string; strategy: string; state: 'preparing' | 'launching' | 'delivering' | 'linked' | 'failed' | 'cancelled'; childUid: string | null; parentUid: string | null; fromHarness: string; toHarness: string; fromName: string; toName: string; error: string | null; limitations: Limitation[] };

export type State = {
  api?: number;
  /** What the host supports, a version per feature (server/features.ts); absent on older hosts. */
  features?: Record<string, number>;
  /** Scheduled work on this host: next, running, waiting for your decision (server/jobs). */
  jobs?: JobsState | null;
  /** Sessions cut off by a crash or restart, waiting to be restored (server/interruptions). */
  interruptions?: InterruptionsState | null;
  /** Scratchpads (server/notes): when `cursor` moves, `GET /api/notes?since=` has what changed; null until the host has read its numbering. */
  notes?: NotesState | null;
  /** Spaces (server/spaces): when `revision` moves, GET /api/spaces has a new list. */
  spaces?: { revision: number } | null;
  /** Checkouts (server/checkouts): active workspaces, overlaps, and reclaimable storage. */
  checkouts?: CheckoutsState | null;
  hostname: string;
  hosts: Host[];
  home: string;
  defaultSession: string;
  sessions: string[];
  windows: Win[];
  history: HistoryItem[];
  presets: Preset[];
  /** The host's Omarchy theme, when it runs Omarchy. */
  omarchy?: { name: string; at: number; font?: string | null } | null;
  /** Handoff: the session last in use, and on which device (this page is `client === CLIENT_ID`). */
  focus?: { key: string; device: string; client: string; at: number } | null;
  /** Stack review on this host: Inbox alerts, sessions fixing findings, branches that are layers. */
  review?: ReviewState | null;
};

export type ReviewAlert = { kind: 'rereview' | 'nopush' | 'ready' | 'restack'; stackId: string; stackTitle: string; pr: number; role: string; title: string; at: number };
export type SessionReviewLink = {
  uid: string;
  key: string;
  stackId: string;
  stackTitle: string;
  pr: number | null;
  role: string;
  relation: 'fixing' | 'branch' | 'owner' | 'origin';
  status: string | null;
  openFindings: number;
  readyToMerge: boolean;
  needsYou: number;
};
export type ReviewState = {
  alerts: ReviewAlert[];
  fixing: { uid: string; stackId: string; pr: number; role: string; count: number; /** Asked to merge the stack up to `pr`, not to fix it. */ merge?: boolean }[];
  branches: { repo: string; branch: string; stackId: string; pr: number; role: string; stackTitle: string }[];
  sessions?: SessionReviewLink[];
};

export type DirState = 'dir' | 'new' | 'file' | 'missing' | 'outside';

export type OmarchyTheme = { name: string; mode: 'dark' | 'light'; colors: Record<string, string>; font?: string | null };

export type Changes = {
  root: string;
  branch: string;
  files: Array<{ code: string; path: string }>;
  stat: string;
  patch: string;
  truncated: boolean;
};

export type WorktreeInfo = {
  path: string;
  branch: string;
  repo: string;
  head: string;
  dirty: number;
  ahead: number;
  /** Allocated on-disk bytes; null until the background measurement lands, or when too large to measure. */
  sizeBytes: number | null;
  logicalBytes: number | null;
  sizePartial: boolean;
  sizeTooLarge: boolean;
  sizeMeasuredAt: number | null;
  lastActivityAt: number;
  live: Array<{ id: string; name: string }>;
  sessions: Array<{ id: string; title: string; lifecycle: string }>;
  orphan: boolean;
};

export type BulkRemoveResult = { path: string; ok: boolean; error?: string; gone?: boolean; reclaimedBytes: number };

export type BranchInfo = { name: string; current: boolean; remote: boolean; worktree?: string | null };
export type BranchList = { current: string | null; branches: BranchInfo[]; dirty: number };

/** `held`: queued because a screen in front of the agent's prompt, or a picker, is up; it goes in once that's answered. */
export type SendResult = { outcome: 'delivered' | 'queued'; windowId: string; resumed: boolean; queued: number; starting?: boolean; queueId?: string; held?: Gate['kind'] | 'picker' };
/** `unsent`: typed in, but the agent's conversation never showed it; not queued (Send now types it again). */
export type QueueItem = { id: string; text: string; enter: boolean; at: number; unsent?: boolean };

/** A session's browser preview (server/preview.ts): its dev server's port, and ah's proxy port for it. */
export type Preview = { uid: string; target: number; port: number; published: boolean };
export type Draft = { text: string; at: number; device: string; client: string };

/** This page load. A draft saved under it is our own, not one from another device. */
export const CLIENT_ID = Math.random().toString(36).slice(2, 12);

export type PreviewInfo = { preview: Preview | null; ports: number[]; live: boolean };

export type SnapshotInfo = {
  id: number;
  uid: string;
  turn: number;
  commit: string;
  kind: 'turn' | 'safety';
  promptExcerpt: string;
  branch: string;
  createdAt: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  skipped: string[];
  submodules: boolean;
};

export type SnapshotList = {
  snapshots: SnapshotInfo[];
  enabled: boolean;
  available: boolean;
  partial: boolean;
  branch: string | null;
};

/** Called whenever the server says we're not signed in (expired, revoked, locked). */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

/** A refused request: the host's message, its HTTP status, and its stable `code` when it sent one. */
export class ApiError extends Error {
  status: number;
  code: string | null;
  /** The whole refusal, for routes that say more (a note's conflict carries the host's note). */
  body: Record<string, unknown> | null;
  constructor(message: string, status: number, code: string | null, body: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-ah': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status === 401) onUnauthorized();
  if (!res.ok) {
    let msg = text;
    let code: string | null = null;
    let body: Record<string, unknown> | null = null;
    try {
      const j = JSON.parse(text);
      msg = j.error ?? text;
      code = typeof j.code === 'string' ? j.code : null;
      body = j && typeof j === 'object' ? j : null;
    } catch {}
    throw new ApiError(msg || res.statusText, res.status, code, body);
  }
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? JSON.parse(text) : text) as T;
}

const enc = encodeURIComponent;

async function postFile(url: string, file: File): Promise<string> {
  const res = await fetch(url, { method: 'POST', headers: { 'x-ah': '1', 'content-type': 'application/octet-stream' }, body: file });
  const body = await res.json();
  if (res.status === 401) onUnauthorized();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  clientLog.uploaded(body.path, file.size, file.type);
  return body.path as string;
}

/**
 * API client for one host. The local daemon is base ""; peers are reached through it
 * at "/h/<name>" (it proxies HTTP, events and terminals), so the browser has one origin.
 */
export function hostApi(base: string) {
  const r = <T>(method: string, path: string, body?: unknown) => request<T>(method, base + path, body);
  return {
    base,
    state: () => r<State>('GET', '/api/state'),
    projects: () => r<string[]>('GET', '/api/projects'),
    /** Whether a path is a folder, a folder ah would create, or unusable; `root` is where new projects go. */
    dir: (path: string) => r<{ state: DirState; root: string; git?: boolean; hasHead?: boolean }>('GET', `/api/dir?path=${encodeURIComponent(path)}`),
    create: (body: { preset: string; cwd: string; session: string; label: string; resume: boolean; worktree?: boolean; create?: boolean; git?: boolean; mode?: string; model?: string; effort?: string; extraArgs?: string }) =>
      r<{ id: string; uid: string; checkoutId?: string; worktree?: string; branch?: string }>('POST', '/api/windows', body),
    order: (uid: string, order: number) => r('POST', `/api/sessions/${enc(uid)}/order`, { order }),
    rename: (uid: string, name: string) => r('PUT', `/api/sessions/${enc(uid)}/name`, { name }),
    kill: (uid: string) => r('POST', `/api/sessions/${enc(uid)}/terminate`),
    terminal: (uid: string) => r<{ terminal: AttachedTerminal | null }>('GET', `/api/sessions/${enc(uid)}/terminal`),
    openTerminal: (uid: string, command?: string) => r<{ terminal: AttachedTerminal }>('POST', `/api/sessions/${enc(uid)}/terminal`, command === undefined ? {} : { command }),
    closeTerminal: (uid: string) => r('DELETE', `/api/sessions/${enc(uid)}/terminal`),
    capture: (uid: string) => r<string>('GET', `/api/sessions/${enc(uid)}/capture?lines=3000`),
    resume: (ref: string) => r<{ id: string; uid: string; resumed: boolean }>('POST', `/api/sessions/${enc(ref)}/resume`),
    forkInfo: (ref: string) => r<ForkInfo>('GET', `/api/sessions/${enc(ref)}/fork-info`),
    fork: (ref: string, body: { name?: string; prompt?: string; model?: string; effort?: string; mode?: string }) => r<ForkResult>('POST', `/api/sessions/${enc(ref)}/fork`, body),
    /** Continue in another agent (server/portable): what it would transfer, then doing it. */
    continuePreview: (ref: string, body: { to: string; intent?: 'continue' | 'fork'; worktree?: boolean; name?: string; model?: string; effort?: string; mode?: string }) => r<ContinuePlan>('POST', `/api/portable/conversations/${enc(ref)}/preview`, body),
    continueIn: (ref: string, body: { to: string; intent?: 'continue' | 'fork'; worktree?: boolean; name?: string; model?: string; effort?: string; mode?: string; idempotencyKey: string }) =>
      r<{ operation: ContinueOp; existed: boolean }>('POST', `/api/portable/conversations/${enc(ref)}/continue`, body),
    continueOp: (id: string) => r<ContinueOp>('GET', `/api/portable/operations/${enc(id)}`),
    recovery: (uid: string) => r<{ auto: boolean; recovery: (Recovery & { key: string }) | null; events: Array<{ at: number; state: string; detail: string }> }>('GET', `/api/sessions/${enc(uid)}/recovery`),
    recoveryAction: (uid: string, body: { action: 'retry' | 'pause' | 'resume' | 'cancel' } | { auto: boolean }) => r<{ auto: boolean }>('POST', `/api/sessions/${enc(uid)}/recovery`, body),
    usage: (o: { by: 'day' | 'model' | 'provider' | 'harness' | 'session'; from?: string; to?: string }) =>
      r<UsageReport>('GET', `/api/usage?by=${o.by}${o.from ? `&from=${o.from}` : ''}${o.to ? `&to=${o.to}` : ''}`),
    usageLimits: () => r<UsageLimits>('GET', '/api/usage/limits'),
    usageExportUrl: (format: 'csv' | 'json') => `${base}/api/usage/export?format=${format}`,
    restore: (uid: string, note = true) => r<Restored>('POST', `/api/sessions/${enc(uid)}/restore`, note ? {} : { note: false }),
    restoreInterrupted: (target: InterruptTarget) => r<{ restored: Restored[]; failed: Array<{ uid: string; error: string; code: string }> }>('POST', '/api/interruptions/restore', target),
    dismissInterrupted: (target: InterruptTarget) => r<{ dismissed: number }>('POST', '/api/interruptions/dismiss', target),
    jobs: () => r<{ jobs: Job[]; state: JobsState }>('GET', '/api/jobs'),
    job: (id: string) => r<Job & { runs: JobRun[] }>('GET', `/api/jobs/${enc(id)}`),
    createJob: (body: { name: string; action: JobAction; trigger: JobTrigger; policy?: Record<string, unknown> }) => r<Job>('POST', '/api/jobs', body),
    jobVerb: (id: string, verb: 'pause' | 'resume' | 'cancel' | 'run') => r<Job | JobRun>('POST', `/api/jobs/${enc(id)}/${verb}`),
    decideRun: (runId: string, approve: boolean, note?: string) => r<JobRun>('POST', `/api/jobs/runs/${enc(runId)}/decide`, { approve, ...(note ? { note } : {}) }),
    // Scratchpads (server/notes, docs/spec/15-scratchpads.md); web/notes.ts keeps them.
    spaces: () => r<SpacesList>('GET', '/api/spaces'),
    checkouts: (repo?: string) => r<CheckoutsOverview>('GET', repo ? `/api/checkouts?repo=${enc(repo)}` : '/api/checkouts'),
    checkout: (id: string) => r<CheckoutView>('GET', `/api/checkouts/${enc(id)}`),
    pinCheckout: (id: string, pinned: boolean) => r<CheckoutView>('POST', `/api/checkouts/${enc(id)}/pin`, { pinned }),
    checkCheckout: (id: string) => r<CheckoutView>('POST', `/api/checkouts/${enc(id)}/check`, {}),
    recreateCheckout: (id: string) => r<CheckoutView>('POST', `/api/checkouts/${enc(id)}/recreate`, {}),
    removeCheckout: (id: string, force = false) => r<{ id: string; path: string; reclaimedBytes: number }>('DELETE', `/api/checkouts/${enc(id)}${force ? '?force=1' : ''}`),
    runCheckoutsGc: (dryRun = false) => r<GcRunResult>('POST', '/api/checkouts/gc', { dryRun }),
    createSpace: (name: string, preferences?: string) => r<{ space: SpaceView }>('POST', '/api/spaces', preferences ? { name, preferences } : { name }),
    removeSpace: (name: string) => r<{ removed: RemovedSpace }>('POST', '/api/spaces/remove', { name }),
    restoreSpace: (name: string) => r<{ space: SpaceView | null }>('POST', '/api/spaces/restore', { name }),
    spacePreferences: (name: string) => r<SpacePreferences>('GET', `/api/spaces/${enc(name)}/preferences`),
    putSpacePreferences: (name: string, text: string) => r<SpacePreferences>('PUT', `/api/spaces/${enc(name)}/preferences`, { text }),
    spaceMemory: (name: string) => r<{ files: MemoryFile[] }>('GET', `/api/spaces/${enc(name)}/memory`),
    putSpaceMemory: (name: string, file: string, text: string) => r<MemoryFile>('PUT', `/api/spaces/${enc(name)}/memory/${enc(file)}`, { text }),
    deleteSpaceMemory: (name: string, file: string) => r('DELETE', `/api/spaces/${enc(name)}/memory/${enc(file)}`),
    notes: (since: number) => r<NotesPage>('GET', `/api/notes?since=${since}`),
    putNote: (id: string, body: { baseRevision: number; writeId: string; title: string; markdown: string; project: NoteProject | null; createdAt: number }) => r<NoteDTO>('PUT', `/api/notes/${enc(id)}`, body),
    deleteNote: (id: string, baseRevision: number, writeId: string) => r<NoteDTO>('DELETE', `/api/notes/${enc(id)}?baseRevision=${baseRevision}&writeId=${enc(writeId)}`),
    /** Hands a note's text to a session (SCR-6); a retry names the same id and is answered from what happened. */
    handNote: (body: { id: string; noteId: string; revision: number; target: string; text: string; resend?: boolean }) => r<NoteHandoff>('POST', '/api/notes/handoffs', body),
    /** A session started from a note (`notes` 2): one on another host names it and its title. */
    noteSession: (noteId: string, body: { uid: string; host?: string; title?: string }) => r<NoteDTO>('POST', `/api/notes/${noteId}/sessions`, body),
    noteHandoff: (id: string) => r<NoteHandoff>('GET', `/api/notes/handoffs/${enc(id)}`),
    /** A copy of a note written into a project folder (SCR-5); 409 file_exists carries a `suggestion`. */
    exportNote: (body: { dir: string; path: string; markdown: string; replace?: boolean; noteId?: string; revision?: number }) => r<{ path: string; bytes: number; replaced: boolean }>('POST', '/api/notes/export', body),
    resolveRun: (runId: string, resend: boolean) => r<JobRun>('POST', `/api/jobs/runs/${enc(runId)}/resolve`, { resend }),
    movePreview: (ref: string, to: string, cwd?: string) => r<MovePreview>('POST', '/api/migrations/preview', { ref, to, ...(cwd ? { cwd } : {}) }),
    moveStart: (ref: string, to: string, o: { cwd?: string; acceptWarnings?: boolean; idempotencyKey: string }) => r<{ migration: Migration; existed: boolean }>('POST', '/api/migrations', { ref, to, ...o }),
    migration: (id: string) => r<Migration>('GET', `/api/migrations/${enc(id)}`),
    moveRetry: (id: string) => r<Migration>('POST', `/api/migrations/${enc(id)}/retry`),
    moveCancel: (id: string) => r<Migration>('POST', `/api/migrations/${enc(id)}/cancel`),
    send: async (ref: string, text: string, enter: boolean) => {
      try {
        const out = await r<SendResult>('POST', `/api/sessions/${enc(ref)}/send`, { text, enter });
        clientLog.event('send', { host: base || 'local', ref, outcome: out.outcome, queued: out.queued, resumed: out.resumed, ...(out.held ? { held: out.held } : {}), enter, ...messageDetail(text) });
        return out;
      } catch (e) {
        clientLog.event('send', { host: base || 'local', ref, outcome: 'failed', error: (e as Error).message, status: (e as ApiError).status, enter, ...messageDetail(text) });
        throw e;
      }
    },
    answer: (uid: string, answer: 'approve' | 'deny') => r('POST', `/api/sessions/${enc(uid)}/answer`, { answer }),
    choose: (uid: string, key: string) => r('POST', `/api/sessions/${enc(uid)}/choose`, { key }),
    /** Types what the screen in front of the prompt asks for (a code, an API key), Esc back, or opens a sign-in's callback address on the host. */
    answerGate: (uid: string, answer: { text: string } | { back: true } | { callback: string }) => r('POST', `/api/sessions/${enc(uid)}/gate`, answer),
    commands: (uid: string) => r<SlashCommand[]>('GET', `/api/sessions/${enc(uid)}/commands`),
    files: (uid: string, q: string) => r<string[]>('GET', `/api/sessions/${enc(uid)}/files?q=${enc(q)}`),
    answerQuestions: (uid: string, answers: QuestionAnswer[]) => r('POST', `/api/sessions/${enc(uid)}/questions`, { answers }),
    answerQuestion: (uid: string, question: string, answer: QuestionAnswer) => r('POST', `/api/sessions/${enc(uid)}/questions`, { current: { question, answer } }),
    queue: (uid: string) => r<QueueItem[]>('GET', `/api/sessions/${enc(uid)}/queue`),
    /** The queue after what the agent never took (`unsent`); positions in it aren't the queue's. */
    queueAndUnsent: (uid: string) => r<QueueItem[]>('GET', `/api/sessions/${enc(uid)}/queue?unsent=1`),
    switchLaunch: (uid: string, change: { model?: string; effort?: string }) => r<SendResult>('POST', `/api/sessions/${enc(uid)}/switch`, change),
    openSettings: (uid: string, setting: 'model' | 'effort' | 'mode') => r<SendResult>('POST', `/api/sessions/${enc(uid)}/settings`, { setting }),
    /** Permission mode, live where the agent cycles modes; `switched: false` means relaunch with it. */
    switchMode: (uid: string, mode: string) => r<{ switched: boolean }>('POST', `/api/sessions/${enc(uid)}/mode`, { mode }),
    /** Hot swap: restart an idle session with a new model/effort/mode, same conversation; no change restarts it as is. */
    relaunch: (uid: string, change: { model?: string; effort?: string; mode?: string }) => r<{ uid: string; id: string }>('POST', `/api/sessions/${enc(uid)}/relaunch`, change),
    /** GUI view: typed transcript events (server/feed). */
    feedUrl: (ref: string) => `${base}/api/sessions/${enc(ref)}/feed/stream?device=${enc(deviceName())}&client=${CLIENT_ID}`,
    feedPage: (ref: string, before: number, limit = 200) => r<FeedPage>('GET', `/api/sessions/${enc(ref)}/feed?before=${before}&limit=${limit}`),
    feedPrompts: (ref: string) => r<{ prompts: FeedPrompt[] }>('GET', `/api/sessions/${enc(ref)}/feed/prompts`),
    /** The tree of what a session's agent spawned (`features.subagents`); a child's ref answers its whole tree. */
    subagents: (ref: string) => r<SubagentTree & { self: string | null }>('GET', `/api/sessions/${enc(ref)}/subagents`),
    interrupt: (uid: string) => r('POST', `/api/sessions/${enc(uid)}/interrupt`, {}),
    clearQueue: (uid: string, itemId?: string) => r('DELETE', `/api/sessions/${enc(uid)}/queue${itemId ? `/${enc(itemId)}` : ''}`),
    preview: (uid: string) => r<PreviewInfo>('GET', `/api/sessions/${enc(uid)}/preview`),
    startPreview: (uid: string, target: number) => r<{ preview: Preview }>('PUT', `/api/sessions/${enc(uid)}/preview`, { target }),
    stopPreview: (uid: string) => r('DELETE', `/api/sessions/${enc(uid)}/preview`),
    moveQueued: (uid: string, itemId: string, to: number) => r<QueueItem[]>('POST', `/api/sessions/${enc(uid)}/queue/${enc(itemId)}/move`, { to }),
    sendNow: (uid: string, itemId: string) => r<SendResult>('POST', `/api/sessions/${enc(uid)}/queue/${enc(itemId)}/send-now`),
    pin: (uid: string, pinned: boolean) => r('POST', `/api/sessions/${enc(uid)}/pin`, { pinned }),
    /** Handoff: tell the host which session this device is on. */
    focus: (key: string) => r('POST', '/api/focus', { key, device: deviceName(), client: CLIENT_ID }),
    /** Unsent composer text kept on the host, so it follows you between devices. */
    draft: (uid: string) => r<{ draft: Draft | null }>('GET', `/api/sessions/${enc(uid)}/draft`).then((d) => d.draft),
    saveDraft: (uid: string, text: string) => r<{ draft: Draft | null }>('PUT', `/api/sessions/${enc(uid)}/draft`, { text, device: deviceName(), client: CLIENT_ID }),
    snapshots: (uid: string) => r<SnapshotList>('GET', `/api/sessions/${enc(uid)}/snapshots`),
    restoreSnapshot: (uid: string, turn: number, interrupt = false) =>
      r<{ safety: SnapshotInfo; restored: SnapshotInfo; notified: boolean }>('POST', `/api/sessions/${enc(uid)}/snapshots/${turn}/restore`, { interrupt }),
    toggleSnapshots: (uid: string, enabled: boolean) => r('POST', `/api/sessions/${enc(uid)}/snapshots/toggle`, { enabled }),
    forget: (ref: string) => r('DELETE', `/api/sessions/${enc(ref)}`),
    changes: (uid: string) => r<Changes>('GET', `/api/sessions/${enc(uid)}/changes`),
    branches: (uid: string) => r<BranchList>('GET', `/api/sessions/${enc(uid)}/branches`),
    switchBranch: (uid: string, branch: string) => r<{ branch: string }>('POST', `/api/sessions/${enc(uid)}/branches`, { branch }),
    pull: (uid: string) => r<PullInfo>('GET', `/api/sessions/${enc(uid)}/pull`),
    subscriptions: () => r<Subscription[]>('GET', '/api/subscriptions'),
    saveSubscription: (body: { id?: string; name: string; baseUrl: string; model: string; apiKey?: string; envName?: string }) =>
      r<Subscription>('POST', '/api/subscriptions', body),
    env: () => r<EnvState>('GET', '/api/env'),
    saveEnv: (body: { name: string; value?: string; secret: boolean }) => r<EnvVar>('POST', '/api/env', body),
    removeEnv: (name: string) => r('DELETE', `/api/env/${enc(name)}`),
    subscriptionModels: (body: { baseUrl: string; apiKey?: string; id?: string }) => r<{ models: string[] }>('POST', '/api/subscriptions/models', body),
    removeSubscription: (id: string) => r('DELETE', `/api/subscriptions/${enc(id)}`),
    defaultSubscription: (id: string) => r('POST', '/api/subscriptions/default', { id }),
    /** One-shot handoff brief from a chat subscription. Not stored as side chat. */
    summarize: (text: string, subscriptionId?: string) =>
      r<{ summary: string }>('POST', '/api/summarize', subscriptionId ? { text, subscriptionId } : { text }),
    chat: (uid: string) => r<{ messages: ChatMsg[]; subscriptionId: string | null }>('GET', `/api/sessions/${enc(uid)}/chat`),
    pickChatSubscription: (uid: string, subscriptionId: string) => r('PUT', `/api/sessions/${enc(uid)}/chat/subscription`, { id: subscriptionId }),
    sendChat: (uid: string, text: string, subscriptionId?: string) =>
      r<ChatReply>('POST', `/api/sessions/${enc(uid)}/chat`, subscriptionId ? { text, subscriptionId } : { text }),
    clearChat: (uid: string) => r('DELETE', `/api/sessions/${enc(uid)}/chat`),
    pastChats: (q?: string) => r<ChatSummary[]>('GET', q ? `/api/chats?q=${enc(q)}` : '/api/chats'),
    search: (p: SearchQuery, all = false) => {
      const qs = new URLSearchParams({ q: p.q });
      if (p.scope) qs.set('in', p.scope);
      if (p.role) qs.set('role', p.role);
      if (p.project) qs.set('p', p.project);
      if (p.host) qs.set('h', p.host);
      if (p.model) qs.set('m', p.model);
      if (p.limit) qs.set('limit', String(p.limit));
      if (p.offset) qs.set('offset', String(p.offset));
      if (p.from) qs.set('from', String(p.from));
      if (p.to) qs.set('to', String(p.to));
      return r<SearchResponse>('GET', `/api/search${all ? '/all' : ''}?${qs}`);
    },
    searchStatus: () => r<SearchStatus>('GET', '/api/search/status'),
    searchRebuild: () => r<SearchStatus>('POST', '/api/search/rebuild', {}),
    searchSetEnabled: (enabled: boolean) => r<SearchStatus>('POST', '/api/search/enabled', { enabled }),
    /** Settings → System: bounce the daemon on this host (systemd brings it back). */
    restart: () => r<{ ok: true }>('POST', '/api/system/restart', {}),
    /** Settings → System: delete dist, rebuild the UI from this checkout, then bounce the daemon. */
    rebuild: () => r<{ ok: true }>('POST', '/api/system/rebuild', {}),
    /** Settings → System: delete everything in ~/.cache/ah/uploads. */
    clearUploads: () => r<{ ok: true; removed: number }>('POST', '/api/system/uploads/clear', {}),
    hooks: () => r<HooksStatus>('GET', '/api/system/hooks'),
    logging: () => r<LoggingStatus>('GET', '/api/system/logging'),
    setLogging: (server: boolean) => r<LoggingStatus>('PUT', '/api/system/logging', { server }),
    /** This device's log, kept beside the host's; answers where. */
    sendClientLog: (bundle: ClientBundle) => r<{ file: string; entries: number }>('POST', '/api/system/logging/client', bundle),
    resetScreenAudit: () => r('DELETE', '/api/system/screen-audit'),
    omarchyTheme: () => r<OmarchyTheme | null>('GET', '/api/omarchy/theme'),
    desktop: () => r<DesktopStatus>('GET', '/api/system/desktop'),
    harnesses: () => r<Harnesses>('GET', '/api/harnesses'),
    checkHarnesses: () => r<Harnesses>('POST', '/api/harnesses/check', {}),
    setHarnessHidden: (id: string, hidden: boolean) => r<Harnesses>('POST', `/api/harnesses/${enc(id)}`, { hidden }),
    addHarness: (agent: { name: string; command: string; resume?: string }) => r<Harnesses>('POST', '/api/harnesses/custom', agent),
    removeHarness: (id: string) => r<Harnesses>('DELETE', `/api/harnesses/custom/${enc(id)}`),
    setDesktop: (action: 'install' | 'uninstall') => r<{ messages: string[]; status: DesktopStatus }>('POST', '/api/system/desktop', { action }),
    setHooks: (action: 'install' | 'uninstall') => r<{ messages: string[]; status: HooksStatus }>('POST', '/api/system/hooks', { action }),
    pastChat: (uid: string, msgId?: number) => r<{ messages: ChatMsg[] }>('GET', `/api/chats/${enc(uid)}${msgId ? `?msgId=${msgId}` : ''}`),
    worktrees: () => r<WorktreeInfo[]>('GET', '/api/worktrees'),
    removeWorktree: (path: string, force: boolean) => r('DELETE', '/api/worktrees', { path, force }),
    removeWorktreesBulk: (paths: string[], force: string[]) => r<{ results: BulkRemoveResult[] }>('POST', '/api/worktrees/remove-bulk', { paths, force }),
    prompts: () => r<Array<{ text: string; at: number }>>('GET', '/api/prompts'),
    clearPrompts: () => r('DELETE', '/api/prompts'),
    /** Pasted/dropped files land in the host's upload folder. */
    upload: (file: File) => postFile(`${base}/api/upload?name=${enc(file.name || 'paste.png')}`, file),
    fs: {
      list: (path: string, hidden: boolean) => r<FsListing>('GET', `/api/fs/list?path=${enc(path)}${hidden ? '&hidden=1' : ''}`),
      url: (path: string, download = false) => `${base}/api/fs/file?path=${enc(path)}${download ? '&download=1' : ''}`,
      /** The @ completion's files under a folder, relative to it (a note's Space: no session to ask). */
      complete: (dir: string, q: string) => r<string[]>('GET', `/api/fs/complete?dir=${enc(dir)}&q=${enc(q)}`),
      mkdir: (path: string) => r<{ path: string }>('POST', '/api/fs/mkdir', { path }),
      upload: (dir: string, file: File) => postFile(`${base}/api/fs/upload?dir=${enc(dir)}&name=${enc(file.name || 'upload')}`, file),
    },
    wsUrl: (windowId: string, cols: number, rows: number) =>
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}/ws/${enc(windowId)}?cols=${cols}&rows=${rows}&device=${enc(deviceName())}&client=${CLIENT_ID}`,
  };
}

export type HostApi = ReturnType<typeof hostApi>;

// ---------- Spaces (server/spaces, docs/spec/17-spaces.md)

export type SpaceKind = 'space' | 'repo' | 'folder';
export type SpaceView = { name: string; kind: SpaceKind; path: string | null; exists: boolean; live: number; conversations: number; lastActivityAt: number };
export type RemovedSpace = { name: string; kind: SpaceKind; path: string | null; removedAt: number; conversations: number; archived: boolean };
export type SpacesList = { root: string; spaces: SpaceView[]; removed: RemovedSpace[] };
export type SpacePreferences = { text: string; file: string; updatedAt: number };
export type MemoryFile = { name: string; text: string; bytes: number; updatedAt: number; truncated?: boolean };

export const api = hostApi('');

/**
 * A freshly created window can miss the next tick: POST /api/windows returns
 * before the ticker lists it, so navigating immediately selects a key nothing
 * matches and the missing-selection fallback bounces to the inbox. Poll the
 * state until the window appears (bounded), then navigate.
 */
export async function waitForWindow(
  fetchState: () => Promise<{ windows: Array<Pick<Win, 'id' | 'uid'>> } | null>,
  ref: { id: string; uid?: string },
  opts?: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<boolean> {
  const tries = opts?.tries ?? 25;
  const delayMs = opts?.delayMs ?? 400;
  const sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < tries; i++) {
    const s = await fetchState().catch(() => null);
    if (s?.windows.some((w) => (ref.uid != null && w.uid === ref.uid) || w.id === ref.id)) return true;
    if (i < tries - 1) await sleep(delayMs);
  }
  return false;
}

/**
 * Fills in what an older server doesn't send, so a page that's newer than the
 * running daemon degrades (with a "restart ah" banner) instead of crashing.
 */
export function normalize(s: State): State {
  return {
    ...s,
    hosts: s.hosts ?? [{ name: s.hostname, self: true, online: true }],
    windows: (s.windows ?? []).map((w) => ({
      ...w,
      title: w.title ?? w.name,
      uid: w.uid ?? w.id,
      devices: w.devices ?? [],
      detail: w.detail ?? null,
      ask: w.ask ?? null,
      answerable: w.answerable ?? false,
      queued: w.queued ?? 0,
      unsent: w.unsent ?? 0,
      pinned: w.pinned ?? false,
      order: w.order ?? null,
      launch: w.launch ?? null,
      launchModel: w.launchModel ?? null,
      launchEffort: w.launchEffort ?? null,
      launchMode: w.launchMode ?? null,
      feed: w.feed ?? null,
      fork: w.fork ?? null,
      continued: w.continued ?? null,
    })),
    history: (s.history ?? []).map((h) => ({ ...h, fork: h.fork ?? null, continued: h.continued ?? null })),
  };
}

/**
 * The next state, keeping what didn't change: a session, history item or host equal to
 * the one before is that same object, and a list with nothing changed is the same list.
 * A patch every 1.5s otherwise made every session new, and every row, pane and open
 * conversation drew again though one line had changed.
 */
export function shareState(prev: State | null, next: State): State {
  if (!prev) return next;
  const list = <T>(was: T[], now: T[], key: (x: T) => string): T[] => {
    const old = new Map(was.map((x) => [key(x), x]));
    let same = was.length === now.length;
    const out = now.map((x, i) => {
      const o = old.get(key(x));
      const keep = o !== undefined && (o === x || JSON.stringify(o) === JSON.stringify(x)) ? o : x;
      if (keep !== was[i]) same = false;
      return keep;
    });
    return same ? was : out;
  };
  return {
    ...next,
    hosts: list(prev.hosts, next.hosts, (h) => h.name),
    windows: list(prev.windows, next.windows, (w) => `${w.host ?? ''}:${w.uid}`),
    history: list(prev.history, next.history, (h) => `${h.host ?? ''}:${h.ref}`),
  };
}

/**
 * This host's state stream, opened at startup beside the sign-in check (main.tsx) instead of
 * after it, so the first state arrives a round trip sooner. subscribe() takes it over with what
 * it already received; signed out, it fails (401) and is dropped; unclaimed, it closes.
 */
let early: { es: EventSource; events: MessageEvent[]; keep: (e: Event) => void } | null = null;
/** This device's stream worked last time (it is signed in, or the host asks no sign-in). */
const STREAM_OK = 'ah.streamOk';
const streamOk = (ok: boolean) => {
  try {
    if (ok) localStorage.setItem(STREAM_OK, '1');
    else localStorage.removeItem(STREAM_OK);
  } catch {}
};
export function openStateEarly() {
  if (early || typeof EventSource === 'undefined') return;
  // Only where it worked before: a signed-out device would just log a refused stream.
  try {
    if (localStorage.getItem(STREAM_OK) !== '1') return;
  } catch {
    return;
  }
  const es = new EventSource('/api/events?delta=1');
  const events: MessageEvent[] = [];
  const keep = (e: Event) => events.push(e as MessageEvent);
  es.addEventListener('state', keep);
  es.addEventListener('patch', keep);
  es.onerror = () => {
    if (es.readyState !== EventSource.CLOSED) return;
    // Refused (signed out since): don't try early next time.
    streamOk(false);
    if (early?.es === es) early = null;
  };
  early = { es, events, keep };
  setTimeout(() => {
    if (early?.es !== es) return;
    es.close();
    early = null;
  }, 15_000);
}

/** Live state over SSE; falls back to polling if the stream can't be held open. */
export function subscribe(onState: (s: State) => void, onError: (msg: string | null) => void, client: HostApi = api): () => void {
  let es: EventSource | null = null;
  let poll: number | undefined;
  let retry: number | undefined;
  let closed = false;
  /** The stream is delivering: its drops and returns go in the device's log once each. */
  let up = false;
  let shared: State | null = null;
  /** The stream's latest state, which patches apply to. */
  let last: State | null = null;
  /** Counts stream events: a fetch that answers after one is older than what it shows. */
  let events = 0;
  const emit = (s: State) => onState((shared = shareState(shared, s)));
  const fetchOnce = () => {
    const at = events;
    return client
      .state()
      .then((s) => {
        if (closed || events !== at) return;
        last = normalize(s);
        emit(last);
        onError(null);
      })
      .catch((e) => !closed && onError(reachText(e)));
  };
  const open = () => {
    if (closed) return;
    // One stream at a time: a retry and a wake-up can both ask for one.
    clearTimeout(retry);
    retry = undefined;
    if (es && es.readyState !== EventSource.CLOSED) return;
    es?.close();
    const adopt = client.base === api.base && early && early.es.readyState !== EventSource.CLOSED ? early : null;
    if (adopt) early = null;
    // ?delta=1: a patch carries the windows that changed, not all of them (an older host sends all).
    es = adopt?.es ?? new EventSource(`${client.base}/api/events?delta=1`);
    // The whole state on connect, then patches of the fields that changed.
    last = null;
    const onFull = (e: Event) => {
      if (!up) clientLog.event('stream', { host: client.base || 'local', phase: 'connected' });
      up = true;
      events++;
      clearInterval(poll);
      poll = undefined;
      last = normalize(JSON.parse((e as MessageEvent).data));
      emit(last);
      onError(null);
      if (client.base === api.base) streamOk(true);
    };
    const onPatch = (e: Event) => {
      if (!last) return;
      events++;
      const data = JSON.parse((e as MessageEvent).data);
      if (data.windowsDelta) {
        const byUid = new Map(last!.windows.map((w) => [w.uid, w] as const));
        for (const w of data.windowsDelta.changed as Win[]) byUid.set(w.uid ?? w.id, w);
        data.windows = (data.windowsDelta.order as string[]).map((uid) => byUid.get(uid)).filter(Boolean);
        delete data.windowsDelta;
      }
      last = normalize({ ...last, ...data });
      emit(last);
    };
    es.addEventListener('state', onFull);
    es.addEventListener('patch', onPatch);
    if (adopt) {
      es.removeEventListener('state', adopt.keep);
      es.removeEventListener('patch', adopt.keep);
      for (const e of adopt.events) (e.type === 'state' ? onFull : onPatch)(e);
    }
    es.onerror = () => {
      if (up) clientLog.event('stream', { host: client.base || 'local', phase: 'dropped', closed: es?.readyState === EventSource.CLOSED, online: navigator.onLine });
      up = false;
      // EventSource reconnects by itself; poll meanwhile so the UI never goes stale.
      poll ??= window.setInterval(fetchOnce, 3000);
      if (es?.readyState === EventSource.CLOSED) retry ??= window.setTimeout(open, 3000);
    };
  };
  open();
  // iOS kills background connections; resync immediately when we come back.
  const wake = () => {
    if (document.visibilityState !== 'visible') return;
    fetchOnce();
    if (!es || es.readyState === EventSource.CLOSED) open();
  };
  document.addEventListener('visibilitychange', wake);
  return () => {
    closed = true;
    es?.close();
    clearInterval(poll);
    clearTimeout(retry);
    document.removeEventListener('visibilitychange', wake);
  };
}

export type FsEntry = { name: string; type: 'dir' | 'file' | 'other'; size: number; mtime: number };
export type FsListing = { path: string; parent: string | null; entries: FsEntry[]; roots?: string[] };

/** A short label for this device, shown to others as "also open on …". */
const DEVICE_KEY = 'ah.deviceName';

/**
 * What other devices call this one: "Continue from …", "also open on …", a
 * draft's origin. The name chosen in Settings → Security, else the platform.
 */
export function deviceName(): string {
  try {
    const own = localStorage.getItem(DEVICE_KEY)?.trim();
    if (own) return own;
  } catch {}
  return platformName();
}

/** Name this device; an empty name goes back to the platform's. */
export function setDeviceName(name: string) {
  try {
    if (name.trim()) localStorage.setItem(DEVICE_KEY, name.trim().slice(0, 40));
    else localStorage.removeItem(DEVICE_KEY);
  } catch {}
}

export function platformName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'browser';
}

/** Quote a path for POSIX shells and agent prompts alike. */
export function shellQuote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}
