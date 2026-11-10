import type { FeedPage, FeedPrompt } from '../server/feed/schema.ts';
import { reachText } from './errors.ts';

export type Status = 'busy' | 'idle' | 'waiting' | 'attention';

export type Win = {
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
  createdAt: number;
  panes: number;
  pinned: boolean;
  queued: number;
  order: number | null;
  launch: string | null;
  launchModel: string | null;
  launchEffort: string | null;
  launchMode: string | null;
  /** Set when the agent's transcript can drive the GUI view. */
  feed: string | null;
  /** Fork lineage (F36): this session is a fork, and how many forks it has. */
  fork: { parentUid: string; parentTitle: string; rootUid: string; forks: number } | null;
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
  /** Rows of a numbered picker on screen; `key` is what gets typed. */
  options?: Array<{ key: string; label: string }>;
  /** The one question the dialog shows now, when the whole set isn't known or it's half answered. */
  dialog?: { question: string; multiSelect: boolean; options: Array<{ label: string; description?: string; checked?: boolean }>; total: number; answered: number };
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
};

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

export type State = {
  api?: number;
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
export type ReviewState = {
  alerts: ReviewAlert[];
  fixing: { uid: string; stackId: string; pr: number; role: string; count: number; /** Asked to merge the stack up to `pr`, not to fix it. */ merge?: boolean }[];
  branches: { repo: string; branch: string; stackId: string; pr: number; role: string; stackTitle: string }[];
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

export type SendResult = { outcome: 'delivered' | 'queued'; windowId: string; resumed: boolean; queued: number; starting?: boolean };
export type QueueItem = { id: string; text: string; enter: boolean; at: number };

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
    try {
      msg = JSON.parse(text).error ?? text;
    } catch {}
    throw new Error(msg || res.statusText);
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
    dir: (path: string) => r<{ state: DirState; root: string }>('GET', `/api/dir?path=${encodeURIComponent(path)}`),
    create: (body: { preset: string; cwd: string; session: string; label: string; resume: boolean; worktree?: boolean; create?: boolean; git?: boolean; mode?: string; model?: string; effort?: string; extraArgs?: string }) =>
      r<{ id: string; uid: string }>('POST', '/api/windows', body),
    order: (uid: string, order: number) => r('POST', `/api/sessions/${enc(uid)}/order`, { order }),
    rename: (uid: string, name: string) => r('PUT', `/api/sessions/${enc(uid)}/name`, { name }),
    kill: (uid: string) => r('POST', `/api/sessions/${enc(uid)}/terminate`),
    capture: (uid: string) => r<string>('GET', `/api/sessions/${enc(uid)}/capture?lines=3000`),
    resume: (ref: string) => r<{ id: string; uid: string; resumed: boolean }>('POST', `/api/sessions/${enc(ref)}/resume`),
    forkInfo: (ref: string) => r<ForkInfo>('GET', `/api/sessions/${enc(ref)}/fork-info`),
    fork: (ref: string, body: { name?: string; prompt?: string; model?: string; effort?: string; mode?: string }) => r<ForkResult>('POST', `/api/sessions/${enc(ref)}/fork`, body),
    send: (ref: string, text: string, enter: boolean) => r<SendResult>('POST', `/api/sessions/${enc(ref)}/send`, { text, enter }),
    answer: (uid: string, answer: 'approve' | 'deny') => r('POST', `/api/sessions/${enc(uid)}/answer`, { answer }),
    choose: (uid: string, key: string) => r('POST', `/api/sessions/${enc(uid)}/choose`, { key }),
    commands: (uid: string) => r<SlashCommand[]>('GET', `/api/sessions/${enc(uid)}/commands`),
    files: (uid: string, q: string) => r<string[]>('GET', `/api/sessions/${enc(uid)}/files?q=${enc(q)}`),
    answerQuestions: (uid: string, answers: QuestionAnswer[]) => r('POST', `/api/sessions/${enc(uid)}/questions`, { answers }),
    answerQuestion: (uid: string, question: string, answer: QuestionAnswer) => r('POST', `/api/sessions/${enc(uid)}/questions`, { current: { question, answer } }),
    queue: (uid: string) => r<QueueItem[]>('GET', `/api/sessions/${enc(uid)}/queue`),
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
      mkdir: (path: string) => r<{ path: string }>('POST', '/api/fs/mkdir', { path }),
      upload: (dir: string, file: File) => postFile(`${base}/api/fs/upload?dir=${enc(dir)}&name=${enc(file.name || 'upload')}`, file),
    },
    wsUrl: (windowId: string, cols: number, rows: number) =>
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}/ws/${enc(windowId)}?cols=${cols}&rows=${rows}&device=${enc(deviceName())}&client=${CLIENT_ID}`,
  };
}

export type HostApi = ReturnType<typeof hostApi>;

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
      pinned: w.pinned ?? false,
      order: w.order ?? null,
      launch: w.launch ?? null,
      launchModel: w.launchModel ?? null,
      launchEffort: w.launchEffort ?? null,
      launchMode: w.launchMode ?? null,
      feed: w.feed ?? null,
      fork: w.fork ?? null,
    })),
    history: (s.history ?? []).map((h) => ({ ...h, fork: h.fork ?? null })),
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
  const es = new EventSource('/api/events');
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
  let closed = false;
  let shared: State | null = null;
  const emit = (s: State) => onState((shared = shareState(shared, s)));
  const fetchOnce = () =>
    client
      .state()
      .then((s) => {
        emit(normalize(s));
        onError(null);
      })
      .catch((e) => onError(reachText(e)));
  const open = () => {
    if (closed) return;
    const adopt = client.base === api.base && early && early.es.readyState !== EventSource.CLOSED ? early : null;
    if (adopt) early = null;
    es = adopt?.es ?? new EventSource(`${client.base}/api/events`);
    // The whole state on connect, then patches of the fields that changed.
    let last: State | null = null;
    const onFull = (e: Event) => {
      clearInterval(poll);
      poll = undefined;
      last = normalize(JSON.parse((e as MessageEvent).data));
      emit(last);
      onError(null);
      if (client.base === api.base) streamOk(true);
    };
    const onPatch = (e: Event) => {
      if (!last) return;
      last = normalize({ ...last, ...JSON.parse((e as MessageEvent).data) });
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
      // EventSource reconnects by itself; poll meanwhile so the UI never goes stale.
      poll ??= window.setInterval(fetchOnce, 3000);
      if (es?.readyState === EventSource.CLOSED) setTimeout(open, 3000);
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
