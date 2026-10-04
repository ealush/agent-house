export type Status = 'busy' | 'idle' | 'waiting' | 'attention';

export type Win = {
  id: string;
  /** Added client-side: which machine, and a selection key unique across machines. */
  host: string;
  key: string;
  session: string;
  index: number;
  name: string;
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
  viewers: number;
  activity: number;
  createdAt: number;
  panes: number;
  pinned: boolean;
  queued: number;
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
};

export type Preset = { id: string; name: string; command: string; resume?: string; available: boolean };

export type Host = { name: string; self: boolean; online: boolean };

export type State = {
  hostname: string;
  hosts: Host[];
  home: string;
  defaultSession: string;
  sessions: string[];
  windows: Win[];
  history: HistoryItem[];
  presets: Preset[];
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
  live: Array<{ id: string; name: string }>;
  sessions: Array<{ id: string; title: string; lifecycle: string }>;
  orphan: boolean;
};

export type SendResult = { outcome: 'delivered' | 'queued'; windowId: string; resumed: boolean; queued: number };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-ah': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
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
    create: (body: { preset: string; cwd: string; session: string; label: string; resume: boolean; worktree?: boolean }) =>
      r<{ id: string; uid: string }>('POST', '/api/windows', body),
    rename: (id: string, name: string) => r('PATCH', `/api/windows/${enc(id)}`, { name }),
    kill: (id: string) => r('DELETE', `/api/windows/${enc(id)}`),
    capture: (id: string) => r<string>('GET', `/api/windows/${enc(id)}/capture?lines=3000`),
    resume: (ref: string) => r<{ id: string; uid: string; resumed: boolean }>('POST', `/api/sessions/${enc(ref)}/resume`),
    send: (ref: string, text: string, enter: boolean) => r<SendResult>('POST', `/api/sessions/${enc(ref)}/send`, { text, enter }),
    clearQueue: (uid: string) => r('DELETE', `/api/sessions/${enc(uid)}/queue`),
    pin: (uid: string, pinned: boolean) => r('POST', `/api/sessions/${enc(uid)}/pin`, { pinned }),
    forget: (ref: string) => r('DELETE', `/api/sessions/${enc(ref)}`),
    changes: (id: string) => r<Changes>('GET', `/api/windows/${enc(id)}/changes`),
    worktrees: () => r<WorktreeInfo[]>('GET', '/api/worktrees'),
    removeWorktree: (path: string, force: boolean) => r('DELETE', '/api/worktrees', { path, force }),
    prompts: () => r<Array<{ text: string; at: number }>>('GET', '/api/prompts'),
    /** Pasted/dropped files land in the host's upload folder. */
    upload: (file: File) => postFile(`${base}/api/upload?name=${enc(file.name || 'paste.png')}`, file),
    fs: {
      list: (path: string, hidden: boolean) => r<FsListing>('GET', `/api/fs/list?path=${enc(path)}${hidden ? '&hidden=1' : ''}`),
      url: (path: string, download = false) => `${base}/api/fs/file?path=${enc(path)}${download ? '&download=1' : ''}`,
      mkdir: (path: string) => r<{ path: string }>('POST', '/api/fs/mkdir', { path }),
      upload: (dir: string, file: File) => postFile(`${base}/api/fs/upload?dir=${enc(dir)}&name=${enc(file.name || 'upload')}`, file),
    },
    wsUrl: (windowId: string, cols: number, rows: number) =>
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}/ws/${enc(windowId)}?cols=${cols}&rows=${rows}`,
  };
}

export type HostApi = ReturnType<typeof hostApi>;

export const api = hostApi('');

/** Live state over SSE; falls back to polling if the stream can't be held open. */
export function subscribe(onState: (s: State) => void, onError: (msg: string | null) => void, client: HostApi = api): () => void {
  let es: EventSource | null = null;
  let poll: number | undefined;
  let closed = false;
  const fetchOnce = () =>
    client
      .state()
      .then((s) => {
        onState(s);
        onError(null);
      })
      .catch((e) => onError((e as Error).message));
  const open = () => {
    if (closed) return;
    es = new EventSource(`${client.base}/api/events`);
    es.addEventListener('state', (e) => {
      clearInterval(poll);
      poll = undefined;
      onState(JSON.parse((e as MessageEvent).data));
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
export type FsListing = { path: string; parent: string | null; entries: FsEntry[] };

/** Quote a path for POSIX shells and agent prompts alike. */
export function shellQuote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}
