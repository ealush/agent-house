// The host daemon's brain: a ticker that re-derives everything from tmux, the
// registry and the harnesses' own stores, plus the few verbs that change things
// (launch, resume, send). HTTP, SSE and the CLI are all thin views over this.
import { hostname } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildWindows, buildHistory, adoptTranscripts, type WindowView, type HistoryItem } from './sessions.ts';
import { Registry, type SessionRecord } from './registry.ts';
import { discover } from './discovery.ts';
import { expandHome, isExecutableOnPath, type Config, type Preset } from './config.ts';
import * as t from './tmux.ts';
import { listWorktrees, mainRepo, removeWorktree, type Worktree } from './git.ts';
import { Push } from './push.ts';
import type { Peers } from './peers.ts';

export type QueueItem = { id: string; text: string; enter: boolean; at: number };

export type Host = { name: string; self: boolean; online: boolean };

/** Bumped when the state shape changes, so a newer page can tell an older server apart. */
export const API_VERSION = 3;

export type State = {
  api: number;
  hostname: string;
  hosts: Host[];
  home: string;
  defaultSession: string;
  sessions: string[];
  windows: WindowView[];
  history: HistoryItem[];
  presets: Array<Preset & { available: boolean }>;
};

export type SendResult = { outcome: 'delivered' | 'queued'; windowId: string; resumed: boolean; queued: number };

export class CoreError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STATE_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah');
const HIDDEN_FILE = join(STATE_DIR, 'hidden.json');
const PROMPTS_FILE = join(STATE_DIR, 'prompts.json');
const MAX_PROMPTS = 60;
const TICK_MS = 1500;
const now = () => Math.floor(Date.now() / 1000);

export class Core {
  readonly registry = new Registry();
  readonly push = new Push();
  readonly viewers: Map<string, string[]>;
  private state: State | null = null;
  private json = '';
  private listeners = new Set<(json: string) => void>();
  private tmuxPath = process.env.PATH ?? '';
  private ticking: Promise<State> | null = null;
  private hidden = new Set<string>();
  private prompts: Array<{ text: string; at: number }> = [];
  private config: Config;
  peers: Peers | null = null;

  constructor(config: Config, viewers: Map<string, string[]>) {
    this.config = config;
    this.viewers = viewers;
    try {
      if (existsSync(HIDDEN_FILE)) this.hidden = new Set(JSON.parse(readFileSync(HIDDEN_FILE, 'utf8')));
      if (existsSync(PROMPTS_FILE)) this.prompts = JSON.parse(readFileSync(PROMPTS_FILE, 'utf8'));
    } catch {}
  }

  start() {
    this.refreshTmuxPath();
    const loop = () => this.tick().catch((err) => console.error('tick failed:', err)).finally(() => setTimeout(loop, TICK_MS));
    loop();
  }

  /** Current state, recomputed if nothing has been computed yet. */
  async current(): Promise<State> {
    return this.state ?? this.tick();
  }

  subscribe(fn: (json: string) => void): () => void {
    this.listeners.add(fn);
    if (this.json) fn(this.json);
    return () => this.listeners.delete(fn);
  }

  /** One pass: tmux → windows → registry → history → queue delivery → push to subscribers. */
  tick(): Promise<State> {
    this.ticking ??= (async () => {
      const windows = await buildWindows(this.config, this.viewers, this.registry);
      adoptTranscripts(windows, await discover(), this.registry);
      await this.deliverQueued(windows);
      this.push.observe(windows);
      const history = (await buildHistory(this.registry, windows)).filter((h) => !this.hidden.has(h.ref));
      const state: State = {
        api: API_VERSION,
        hostname: hostname(),
        hosts: [
          { name: hostname(), self: true, online: true },
          ...(this.peers?.list() ?? []).map((p) => ({ name: p.name, self: false, online: p.online })),
        ],
        home: homedir(),
        defaultSession: this.config.defaultSession,
        sessions: await t.listSessions(),
        windows,
        history,
        presets: this.config.presets.map((p) => ({ ...p, available: isExecutableOnPath(p.command, this.tmuxPath) })),
      };
      this.state = state;
      const json = JSON.stringify(state);
      if (json !== this.json) {
        this.json = json;
        for (const fn of this.listeners) fn(json);
      }
      return state;
    })().finally(() => (this.ticking = null));
    return this.ticking;
  }

  async refreshTmuxPath() {
    // Agents launch inside tmux shells, so check availability against tmux's PATH.
    try {
      const out = await t.tmux('show-environment', '-g', 'PATH');
      this.tmuxPath = out.trim().replace(/^PATH=/, '') + ':' + (process.env.PATH ?? '');
    } catch {}
  }

  preset(id: string): Preset {
    const p = this.config.presets.find((p) => p.id === id);
    if (!p) throw new CoreError(400, `unknown harness: ${id}`);
    return p;
  }

  // ---------- launch / resume

  async launch(o: { preset: Preset; cwd: string; session: string; name: string; command: string; uid?: string; harnessId?: string; pendingResume?: boolean; meta?: Record<string, unknown> }) {
    const uid = o.uid ?? Registry.newId();
    const windowId = await t.createWindow({ session: o.session, cwd: o.cwd, name: o.name });
    const ts = String(now());
    await t.setWindowOption(windowId, '@ah-uid', uid);
    await t.setWindowOption(windowId, '@ah-agent', o.preset.id);
    await t.setWindowOption(windowId, '@ah-created', ts);
    await t.setWindowOption(windowId, '@ah-seen', ts);
    if (o.harnessId) {
      await t.setWindowOption(windowId, '@ah-harness', o.preset.id);
      await t.setWindowOption(windowId, '@ah-harness-id', o.harnessId);
    }
    this.registry.starting(uid, {
      harness: o.preset.id,
      harnessId: o.harnessId,
      cwd: o.cwd,
      title: o.name,
      tmux: { session: o.session, windowId },
      pendingResume: o.pendingResume,
      meta: o.meta,
    });
    if (o.command) await t.sendLine(windowId, o.command);
    this.tick().catch(() => {});
    return { uid, windowId };
  }

  /**
   * Brings a session back. `ref` is a registry id or `harness:harnessId` from discovery.
   * Live sessions are returned as-is: callers never need to know which case they hit.
   */
  async resume(ref: string): Promise<{ uid: string; windowId: string; resumed: boolean }> {
    const state = await this.current();
    const rec = this.registry.get(ref);
    if (rec && (rec.lifecycle === 'live' || rec.lifecycle === 'starting')) {
      const w = state.windows.find((w) => w.uid === rec.id);
      if (w) return { uid: rec.id, windowId: w.id, resumed: false };
    }

    let harness: string;
    let harnessId: string | undefined;
    let cwd: string;
    let title: string;
    let uid: string | undefined;
    let session = this.config.defaultSession;
    let meta: Record<string, unknown> | undefined;

    if (rec) {
      ({ harness, harnessId, cwd, title } = rec);
      uid = rec.id;
      if (rec.tmux?.session && (await t.hasSession(rec.tmux.session))) session = rec.tmux.session;
    } else {
      const [h, ...rest] = ref.split(':');
      const id = rest.join(':');
      const found = (await discover()).find((x) => x.harness === h && x.harnessId === id);
      if (!found) throw new CoreError(404, 'session not found');
      ({ harness, harnessId, cwd, title } = found);
      title = shortTitle(title);
      meta = { 'ah.source': 'discovered' };
      // Already running somewhere (e.g. resumed from another device a moment ago)?
      const w = state.windows.find((w) => w.harnessId === harnessId);
      if (w) return { uid: w.uid, windowId: w.id, resumed: false };
    }

    const preset = this.preset(harness);
    // Exact conversation when we know its id, else "most recent in this directory".
    const command = !preset.command ? '' : harnessId && preset.resumeId ? preset.resumeId.replace('{id}', harnessId) : (preset.resume ?? preset.command);
    const dir = (await isDir(cwd)) ? cwd : homedir();
    const out = await this.launch({ preset, cwd: dir, session, name: title || preset.id, command, uid, harnessId, pendingResume: true, meta });
    return { ...out, resumed: true };
  }

  // ---------- send (F8 alive/dead branch, F22 durable queue)

  /**
   * Delivers a prompt to a session wherever it is: typed in now if the agent is idle,
   * queued until its next idle moment if busy, and resumed first if it isn't running.
   */
  async send(ref: string, text: string, enter = true): Promise<SendResult> {
    if (!text) throw new CoreError(400, 'empty message');
    const target = await this.resume(ref);
    this.remember(text);
    const state = target.resumed ? await this.tick() : await this.current();
    const w = state.windows.find((w) => w.id === target.windowId);
    const queue = this.queue(target.uid);
    // Shells take input immediately (a dev server is always "busy"); agents get queued while working.
    const ready = !target.resumed && w && queue.length === 0 && (!w.agent || w.status === 'idle' || w.status === 'attention');
    if (ready) {
      await t.pasteText(target.windowId, text, enter);
      return { outcome: 'delivered', windowId: target.windowId, resumed: false, queued: 0 };
    }
    queue.push({ id: randomUUID().slice(0, 8), text, enter, at: now() });
    this.registry.setMeta(target.uid, 'ah.queue', queue);
    return { outcome: 'queued', windowId: target.windowId, resumed: target.resumed, queued: queue.length };
  }

  /** Recently sent prompts, newest first, shared by every device (resend from history). */
  recentPrompts() {
    return this.prompts;
  }

  private remember(text: string) {
    this.prompts = [{ text, at: now() }, ...this.prompts.filter((p) => p.text !== text)].slice(0, MAX_PROMPTS);
    mkdir(STATE_DIR, { recursive: true })
      .then(() => writeFile(PROMPTS_FILE, JSON.stringify(this.prompts), { mode: 0o600 }))
      .catch((err) => console.error('saving prompt history failed:', err));
  }

  queue(uid: string): QueueItem[] {
    return [...((this.registry.get(uid)?.meta['ah.queue'] as QueueItem[] | undefined) ?? [])];
  }

  clearQueue(uid: string, itemId?: string) {
    const rest = itemId ? this.queue(uid).filter((q) => q.id !== itemId) : [];
    this.registry.setMeta(uid, 'ah.queue', rest.length ? rest : undefined);
  }

  private async deliverQueued(windows: WindowView[]) {
    const t0 = now();
    for (const w of windows) {
      if (!w.queued || (w.status !== 'idle' && w.status !== 'attention')) continue;
      // Freshly (re)started agents render their UI first; don't type into a half-drawn TUI.
      if (t0 - (w.createdAt || 0) < 5) continue;
      const [next, ...rest] = this.queue(w.uid);
      if (!next) continue;
      // Remove before typing: at-most-once, never a duplicate turn (F16).
      this.registry.setMeta(w.uid, 'ah.queue', rest.length ? rest : undefined);
      await t.pasteText(w.id, next.text, next.enter).catch((err) => console.error(`queue delivery to ${w.id} failed:`, err));
      w.queued = rest.length;
      w.status = 'busy';
    }
  }

  /**
   * One-tap answer to a permission prompt. Re-checks against a fresh tick that the
   * session is *still* waiting, so a stale button never types into a live agent.
   */
  async answer(uid: string, answer: 'approve' | 'deny') {
    const state = await this.tick();
    const w = state.windows.find((w) => w.uid === uid);
    if (!w) throw new CoreError(404, 'session not found');
    if (w.status !== 'waiting') throw new CoreError(409, 'it is no longer waiting');
    if (!w.answerable || !w.agent) throw new CoreError(400, 'this prompt needs a reply, not approve/deny');
    const keys = answer === 'approve' ? this.preset(w.agent).approveKeys : this.preset(w.agent).denyKeys;
    if (!keys?.length) throw new CoreError(400, `no ${answer} keys configured for ${w.agent}`);
    await t.tmux('send-keys', '-t', w.id, ...keys);
    this.tick().catch(() => {});
  }

  // ---------- small mutations

  setPinned(ref: string, pinned: boolean) {
    if (!this.registry.get(ref)) throw new CoreError(404, 'only sessions ah has run can be pinned');
    this.registry.setMeta(ref, 'ah.pinned', pinned || undefined);
    this.tick().catch(() => {});
  }

  async forget(ref: string) {
    const rec = this.registry.get(ref);
    if (rec && (rec.lifecycle === 'live' || rec.lifecycle === 'starting')) throw new CoreError(409, 'session is running');
    if (rec) this.registry.remove(ref);
    else this.hidden.add(ref);
    if (rec?.harnessId) this.hidden.add(`${rec.harness}:${rec.harnessId}`);
    await mkdir(dirname(HIDDEN_FILE), { recursive: true });
    await writeFile(HIDDEN_FILE, JSON.stringify([...this.hidden]));
    this.tick().catch(() => {});
  }

  // ---------- worktrees (F30): what exists, who uses it, what's safe to clean up

  async worktrees() {
    const state = await this.current();
    const repos = new Set<string>();
    for (const r of this.registry.all()) {
      const wt = r.meta['ah.worktree'] as Worktree | undefined;
      if (wt?.repo) repos.add(wt.repo);
    }
    for (const w of state.windows) if (w.worktree) repos.add(await mainRepo(expandHome(w.cwd)).catch(() => ''));
    repos.delete('');
    const list = await listWorktrees([...repos]);
    return list.map((wt) => {
      const users = state.windows.filter((w) => expandHome(w.cwd) === wt.path || expandHome(w.cwd).startsWith(wt.path + '/'));
      const owners = this.registry.all().filter((r) => (r.meta['ah.worktree'] as Worktree | undefined)?.path === wt.path);
      return {
        ...wt,
        live: users.map((w) => ({ id: w.id, name: w.name })),
        sessions: owners.map((r) => ({ id: r.id, title: r.title, lifecycle: r.lifecycle })),
        orphan: users.length === 0,
      };
    });
  }

  async removeWorktree(path: string, force: boolean) {
    const state = await this.current();
    if (state.windows.some((w) => expandHome(w.cwd) === path || expandHome(w.cwd).startsWith(path + '/'))) {
      throw new CoreError(409, 'a live session is using this worktree');
    }
    await removeWorktree(path, force);
  }

  record(ref: string): SessionRecord | undefined {
    return this.registry.get(ref);
  }
}

function shortTitle(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 40 ? one.slice(0, 39) + '…' : one;
}

async function isDir(p: string): Promise<boolean> {
  return !!(await stat(p).catch(() => null))?.isDirectory();
}

export async function resolveDir(input: string): Promise<string> {
  const dir = resolve(expandHome(input.trim() || '~'));
  if (!(await isDir(dir))) throw new CoreError(400, `not a directory: ${input}`);
  return dir;
}

export function defaultName(preset: Preset, cwd: string): string {
  return preset.command ? preset.id : basename(cwd) || 'shell';
}
