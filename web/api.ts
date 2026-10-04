export type Status = 'busy' | 'idle' | 'waiting' | 'attention';

export type Win = {
  id: string;
  session: string;
  index: number;
  name: string;
  uid: string | null;
  agent: string | null;
  model: string | null;
  hooked: boolean;
  command: string;
  cwd: string;
  project: string;
  projectPath: string;
  status: Status;
  viewers: number;
  activity: number;
  createdAt: number;
  panes: number;
};

export type Preset = { id: string; name: string; command: string; resume?: string; available: boolean };

export type State = {
  hostname: string;
  defaultSession: string;
  sessions: string[];
  windows: Win[];
  ended: Ended[];
  presets: Preset[];
};

export type Ended = {
  uid: string;
  name: string;
  cwd: string;
  harness: string;
  harnessId?: string;
  tmuxSession: string;
  endedAt: number;
};

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

export const api = {
  state: () => request<State>('GET', '/api/state'),
  projects: () => request<string[]>('GET', '/api/projects'),
  create: (body: { preset: string; cwd: string; session: string; label: string; resume: boolean }) =>
    request<{ id: string }>('POST', '/api/windows', body),
  rename: (id: string, name: string) => request('PATCH', `/api/windows/${encodeURIComponent(id)}`, { name }),
  kill: (id: string) => request('DELETE', `/api/windows/${encodeURIComponent(id)}`),
  resume: (uid: string) => request<{ id: string }>('POST', `/api/sessions/${encodeURIComponent(uid)}/resume`),
  forget: (uid: string) => request('DELETE', `/api/sessions/${encodeURIComponent(uid)}`),
  capture: (id: string) => request<string>('GET', `/api/windows/${encodeURIComponent(id)}/capture?lines=3000`),
};

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
