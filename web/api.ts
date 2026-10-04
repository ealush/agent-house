export type Status = 'busy' | 'idle' | 'waiting' | 'attention';

export type Win = {
  id: string;
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

export type State = {
  hostname: string;
  defaultSession: string;
  sessions: string[];
  windows: Win[];
  history: HistoryItem[];
  presets: Preset[];
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

export const api = {
  state: () => request<State>('GET', '/api/state'),
  projects: () => request<string[]>('GET', '/api/projects'),
  create: (body: { preset: string; cwd: string; session: string; label: string; resume: boolean }) =>
    request<{ id: string; uid: string }>('POST', '/api/windows', body),
  rename: (id: string, name: string) => request('PATCH', `/api/windows/${enc(id)}`, { name }),
  kill: (id: string) => request('DELETE', `/api/windows/${enc(id)}`),
  capture: (id: string) => request<string>('GET', `/api/windows/${enc(id)}/capture?lines=3000`),
  resume: (ref: string) => request<{ id: string; uid: string; resumed: boolean }>('POST', `/api/sessions/${enc(ref)}/resume`),
  send: (ref: string, text: string, enter: boolean) => request<SendResult>('POST', `/api/sessions/${enc(ref)}/send`, { text, enter }),
  clearQueue: (uid: string) => request('DELETE', `/api/sessions/${enc(uid)}/queue`),
  pin: (uid: string, pinned: boolean) => request('POST', `/api/sessions/${enc(uid)}/pin`, { pinned }),
  forget: (ref: string) => request('DELETE', `/api/sessions/${enc(ref)}`),
  prompts: () => request<Array<{ text: string; at: number }>>('GET', '/api/prompts'),
};

/** Live state over SSE; falls back to polling if the stream can't be held open. */
export function subscribe(onState: (s: State) => void, onError: (msg: string | null) => void): () => void {
  let es: EventSource | null = null;
  let poll: number | undefined;
  let closed = false;
  const fetchOnce = () =>
    api
      .state()
      .then((s) => {
        onState(s);
        onError(null);
      })
      .catch((e) => onError((e as Error).message));
  const open = () => {
    if (closed) return;
    es = new EventSource('/api/events');
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

export async function upload(file: File): Promise<string> {
  const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name || 'paste.png')}`, {
    method: 'POST',
    headers: { 'x-ah': '1', 'content-type': 'application/octet-stream' },
    body: file,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body.path as string;
}

/** Quote a path for POSIX shells and agent prompts alike. */
export function shellQuote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}
