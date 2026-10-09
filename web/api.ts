import type { FeedPage } from '../server/feed/schema.ts';

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
  /** Fleet recipe membership (issue #6); null for standalone sessions. */
  run: { runId: string; recipeId: string; key: string; name: string } | null;
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

export type Ask = { kind: 'command' | 'tool' | 'question' | 'screen'; text: string };

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
  modelArgs?: string[];
  settingsCommands?: { model?: string; effort?: string; mode?: string };
  available: boolean;
};

export type Host = { name: string; self: boolean; online: boolean };

export const API_VERSION = 14;

export type PullInfo = { number: number | null; url: string | null };

export type Subscription = { id: string; name: string; baseUrl: string; model: string; hasKey: boolean; isDefault: boolean };
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

export type RecipeMember = {
  key: string;
  preset: string;
  title?: string;
  worktree?: boolean;
  cwdFrom?: string;
  model?: string | null;
  effort?: string | null;
  mode?: string | null;
  prompt?: string;
};

export type Recipe = {
  id: string;
  name: string;
  description?: string;
  members: RecipeMember[];
  handoffs?: Array<{ when: { session: string; event: string }; sendTo: string; template: string; repeat?: boolean }>;
  /** Validation problems reported by the server; a recipe with any cannot launch. */
  errors?: string[];
};

export type RunMemberView = { key: string; uid: string; title: string; preset: string; cwd: string; branch: string | null; status: string };
export type HandoffView = {
  id: string;
  sourceKey: string;
  targetKey: string;
  event: string;
  state: string;
  deliveredAt?: number | null;
  reason?: string | null;
};
export type RunView = {
  runId: string;
  recipeId: string;
  name: string;
  cwd: string;
  brief: string;
  state: string;
  reason?: string | null;
  createdAt: number;
  members: RunMemberView[];
  handoffs: HandoffView[];
};

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
  runs: RunView[];
};

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
export type BranchList = { current: string | null; branches: BranchInfo[] };

export type SendResult = { outcome: 'delivered' | 'queued'; windowId: string; resumed: boolean; queued: number };
export type QueueItem = { id: string; text: string; enter: boolean; at: number; source?: string; handoffId?: string };

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    create: (body: { preset: string; cwd: string; session: string; label: string; resume: boolean; worktree?: boolean; mode?: string; model?: string; effort?: string; extraArgs?: string }) =>
      r<{ id: string; uid: string }>('POST', '/api/windows', body),
    order: (uid: string, order: number) => r('POST', `/api/sessions/${enc(uid)}/order`, { order }),
    rename: (id: string, name: string) => r('PATCH', `/api/windows/${enc(id)}`, { name }),
    kill: (id: string) => r('DELETE', `/api/windows/${enc(id)}`),
    capture: (id: string) => r<string>('GET', `/api/windows/${enc(id)}/capture?lines=3000`),
    resume: (ref: string) => r<{ id: string; uid: string; resumed: boolean }>('POST', `/api/sessions/${enc(ref)}/resume`),
    forkInfo: (ref: string) => r<ForkInfo>('GET', `/api/sessions/${enc(ref)}/fork-info`),
    fork: (ref: string, body: { name?: string; prompt?: string; model?: string; effort?: string; mode?: string }) => r<ForkResult>('POST', `/api/sessions/${enc(ref)}/fork`, body),
    send: (ref: string, text: string, enter: boolean) => r<SendResult>('POST', `/api/sessions/${enc(ref)}/send`, { text, enter }),
    answer: (uid: string, answer: 'approve' | 'deny') => r('POST', `/api/sessions/${enc(uid)}/answer`, { answer }),
    queue: (uid: string) => r<QueueItem[]>('GET', `/api/sessions/${enc(uid)}/queue`),
    switchLaunch: (uid: string, change: { model?: string; effort?: string }) => r<SendResult>('POST', `/api/sessions/${enc(uid)}/switch`, change),
    openSettings: (uid: string, setting: 'model' | 'effort' | 'mode') => r<SendResult>('POST', `/api/sessions/${enc(uid)}/settings`, { setting }),
    /** Hot swap: restart an idle session with a new model/effort, same conversation. */
    relaunch: (uid: string, change: { model?: string; effort?: string }) => r<{ uid: string; id: string }>('POST', `/api/sessions/${enc(uid)}/relaunch`, change),
    /** GUI view: typed transcript events (server/feed). */
    feedUrl: (ref: string) => `${base}/api/sessions/${enc(ref)}/feed/stream`,
    feedPage: (ref: string, before: number, limit = 200) => r<FeedPage>('GET', `/api/sessions/${enc(ref)}/feed?before=${before}&limit=${limit}`),
    interrupt: (uid: string) => r('POST', `/api/sessions/${enc(uid)}/interrupt`, {}),
    clearQueue: (uid: string, itemId?: string) => r('DELETE', `/api/sessions/${enc(uid)}/queue${itemId ? `/${enc(itemId)}` : ''}`),
    sendNow: (uid: string, itemId: string) => r<SendResult>('POST', `/api/sessions/${enc(uid)}/queue/${enc(itemId)}/send-now`),
    pin: (uid: string, pinned: boolean) => r('POST', `/api/sessions/${enc(uid)}/pin`, { pinned }),
    snapshots: (uid: string) => r<SnapshotList>('GET', `/api/sessions/${enc(uid)}/snapshots`),
    restoreSnapshot: (uid: string, turn: number, interrupt = false) =>
      r<{ safety: SnapshotInfo; restored: SnapshotInfo }>('POST', `/api/sessions/${enc(uid)}/snapshots/${turn}/restore`, { interrupt }),
    toggleSnapshots: (uid: string, enabled: boolean) => r('POST', `/api/sessions/${enc(uid)}/snapshots/toggle`, { enabled }),
    forget: (ref: string) => r('DELETE', `/api/sessions/${enc(ref)}`),
    changes: (id: string) => r<Changes>('GET', `/api/windows/${enc(id)}/changes`),
    branches: (id: string) => r<BranchList>('GET', `/api/windows/${enc(id)}/branches`),
    switchBranch: (id: string, branch: string) => r<{ branch: string }>('POST', `/api/windows/${enc(id)}/branches`, { branch }),
    pull: (id: string) => r<PullInfo>('GET', `/api/windows/${enc(id)}/pull`),
    subscriptions: () => r<Subscription[]>('GET', '/api/subscriptions'),
    saveSubscription: (body: { id?: string; name: string; baseUrl: string; model: string; apiKey?: string }) =>
      r<Subscription>('POST', '/api/subscriptions', body),
    removeSubscription: (id: string) => r('DELETE', `/api/subscriptions/${enc(id)}`),
    defaultSubscription: (id: string) => r('POST', '/api/subscriptions/default', { id }),
    chat: (id: string) => r<{ messages: ChatMsg[]; subscriptionId: string | null }>('GET', `/api/windows/${enc(id)}/chat`),
    sendChat: (id: string, text: string, subscriptionId?: string) =>
      r<ChatReply>('POST', `/api/windows/${enc(id)}/chat`, subscriptionId ? { text, subscriptionId } : { text }),
    clearChat: (id: string) => r('DELETE', `/api/windows/${enc(id)}/chat`),
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
    pastChat: (uid: string, msgId?: number) => r<{ messages: ChatMsg[] }>('GET', `/api/chats/${enc(uid)}${msgId ? `?msgId=${msgId}` : ''}`),
    recipes: () => r<Recipe[]>('GET', '/api/recipes'),
    saveRecipes: (recipes: Recipe[]) => r<Recipe[]>('PUT', '/api/recipes', { recipes }),
    launchRecipe: (id: string, body: { cwd: string; brief: string; session?: string; overrides?: Record<string, { mode?: string; model?: string; effort?: string }> }) =>
      r<{ run: RunView; members: Array<{ key: string; uid: string; id: string }> }>('POST', `/api/recipes/${enc(id)}/launch`, body),
    run: (runId: string) => r<RunView>('GET', `/api/runs/${enc(runId)}`),
    stopRun: (runId: string) => r('POST', `/api/runs/${enc(runId)}/stop`, {}),
    archiveRun: (runId: string) => r('POST', `/api/runs/${enc(runId)}/archive`, {}),
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
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}/ws/${enc(windowId)}?cols=${cols}&rows=${rows}&device=${enc(deviceName())}`,
  };
}

export type HostApi = ReturnType<typeof hostApi>;

export const api = hostApi('');

/**
 * Fills in what an older server doesn't send, so a page that's newer than the
 * running daemon degrades (with a "restart ah" banner) instead of crashing.
 */
export function normalize(s: State): State {
  return {
    ...s,
    hosts: s.hosts ?? [{ name: s.hostname, self: true, online: true }],
    runs: s.runs ?? [],
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
      run: w.run ?? null,
    })),
    history: (s.history ?? []).map((h) => ({ ...h, fork: h.fork ?? null })),
  };
}

/** Live state over SSE; falls back to polling if the stream can't be held open. */
export function subscribe(onState: (s: State) => void, onError: (msg: string | null) => void, client: HostApi = api): () => void {
  let es: EventSource | null = null;
  let poll: number | undefined;
  let closed = false;
  const fetchOnce = () =>
    client
      .state()
      .then((s) => {
        onState(normalize(s));
        onError(null);
      })
      .catch((e) => onError((e as Error).message));
  const open = () => {
    if (closed) return;
    es = new EventSource(`${client.base}/api/events`);
    es.addEventListener('state', (e) => {
      clearInterval(poll);
      poll = undefined;
      onState(normalize(JSON.parse((e as MessageEvent).data)));
      onError(null);
    });
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
export function deviceName(): string {
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
