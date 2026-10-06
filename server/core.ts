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
import { PromptStore } from './prompts.ts';
import { discover } from './discovery.ts';
import { expandHome, isExecutableOnPath, type Config, type Preset } from './config.ts';
import { buildLaunch, customModel, resumeSelection } from './launch.ts';
import { withCatalog } from './catalog.ts';
import * as t from './tmux.ts';
import { listWorktrees, mainRepo, removeWorktree, type Worktree } from './git.ts';
import { Push } from './push.ts';
import type { Peers } from './peers.ts';
import type { TranscriptSource } from './search.ts';

type LaunchChange = { model?: string; effort?: string };
export type QueueItem = { id: string; text: string; enter: boolean; at: number; launchChange?: LaunchChange };

export type Host = { name: string; self: boolean; online: boolean };

/** Bumped when the state shape or API routes change, so a newer page can tell an older server apart. */
export const API_VERSION = 12;

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

const TICK_MS = 1500;
const now = () => Math.floor(Date.now() / 1000);

export class Core {
  readonly registry: Registry;
  readonly push = new Push();
  readonly viewers: Map<string, string[]>;
  private state: State | null = null;
  private json = '';
  private listeners = new Set<(json: string) => void>();
  private tmuxPath = process.env.PATH ?? '';
  private ticking: Promise<State> | null = null;
  private hidden = new Set<string>();
  private prompts: Array<{ text: string; at: number }> = [];
  private promptStore: PromptStore;
  private config: Config;
  private resuming = new Map<string, Promise<{ uid: string; windowId: string; resumed: boolean }>>();
  private inputs = new Map<string, Promise<unknown>>();
  private sentAt = new Map<string, number>();
  peers: Peers | null = null;

  constructor(config: Config, viewers: Map<string, string[]>, registry = new Registry(), prompts = new PromptStore()) {
    this.registry = registry;
    this.promptStore = prompts;
    this.config = config;
    this.viewers = viewers;
    try {
      if (existsSync(HIDDEN_FILE)) this.hidden = new Set(JSON.parse(readFileSync(HIDDEN_FILE, 'utf8')));
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
      // A just-started agent's transcript appears within seconds; look for it sooner
      // than the usual rescan so its title and GUI view don't lag behind.
      const fresh = windows.some((w) => w.agent && !w.harnessId && Date.now() / 1000 - w.createdAt < 120);
      adoptTranscripts(windows, await discover(fresh ? 2000 : 15_000), this.registry);
      // A submit can precede the agent's next hook/output. Protect that interval
      // so a second device or queued prompt cannot submit another turn into it.
      for (const w of windows) {
        if (w.agent && this.justSent(w.uid) && (w.status === 'idle' || w.status === 'attention')) w.status = 'busy';
      }
      const alive = new Set(windows.map((w) => w.uid));
      for (const uid of this.sentAt.keys()) if (!alive.has(uid)) this.sentAt.delete(uid);
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
        presets: await Promise.all(this.config.presets.map(async (p) => ({ ...(await withCatalog(p)), available: isExecutableOnPath(p.command, this.tmuxPath) }))),
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

  /**
   * Which transcript the GUI view reads for `ref` (a live uid, a registry id, or
   * `harness:harnessId`). `file` is null until the agent has written one.
   */
  async feedSource(ref: string, maxAgeMs = 15_000): Promise<{ adapter: string; harness: string; file: string | null } | 'no-adapter' | null> {
    const state = await this.current();
    const live = state.windows.find((w) => w.uid === ref);
    const rec = this.registry.get(ref);
    let harness: string | null = live?.agent ?? rec?.harness ?? null;
    let harnessId: string | null = live ? live.harnessId : (rec?.harnessId ?? null);
    if (!live && !rec) {
      const i = ref.indexOf(':');
      if (i <= 0) return null;
      [harness, harnessId] = [ref.slice(0, i), ref.slice(i + 1)];
    }
    if (!harness) return 'no-adapter';
    const adapter = this.config.presets.find((p) => p.id === harness)?.feed;
    if (!adapter) return 'no-adapter';
    if (!harnessId) return { adapter, harness, file: null };
    const found = (await discover(maxAgeMs)).find((t) => t.harness === adapter && t.harnessId === harnessId);
    return { adapter, harness, file: found?.file ?? null };
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
    const rec = this.registry.get(ref);
    const key = rec?.harnessId ? `${rec.harness}:${rec.harnessId}` : ref;
    const pending = this.resuming.get(key);
    if (pending) return pending;
    const task = this.resumeOnce(ref);
    this.resuming.set(key, task);
    try {
      return await task;
    } finally {
      if (this.resuming.get(key) === task) this.resuming.delete(key);
    }
  }

  private async resumeOnce(ref: string): Promise<{ uid: string; windowId: string; resumed: boolean }> {
    const state = await this.tick();
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
      const w = state.windows.find((w) => w.agent === harness && w.harnessId === harnessId);
      if (w) return { uid: w.uid, windowId: w.id, resumed: false };
    }

    const preset = await withCatalog(this.preset(harness));
    // Exact conversation when we know its id, else "most recent in this directory".
    // Previous launch mode/model are preserved (F42); flags that don't apply to
    // resume are dropped by the builder via `appliesTo`.
    const prevSel = rec ? resumeSelection((rec.meta ?? {}) as Record<string, unknown>) : {};
    let command: string;
    let launchMeta: Record<string, unknown> | undefined = meta;
    try {
      const plan = buildLaunch(preset, { ...prevSel, resume: harnessId ?? true });
      command = plan.command;
      launchMeta = { ...plan.meta, ...meta };
    } catch {
      command = !preset.command ? '' : harnessId && preset.resumeId ? preset.resumeId.replace('{id}', harnessId) : (preset.resume ?? preset.command);
    }
    const dir = (await isDir(cwd)) ? cwd : homedir();
    const out = await this.launch({ preset, cwd: dir, session, name: title || preset.id, command, uid, harnessId, pendingResume: true, meta: launchMeta });
    return { ...out, resumed: true };
  }

  // ---------- send (F8 alive/dead branch, F22 durable queue)

  /**
   * Delivers a prompt to a session wherever it is: typed in now if the agent is idle,
   * queued until its next idle moment if busy, and resumed first if it isn't running.
   */
  async send(ref: string, text: string, enter = true, launchChange?: LaunchChange): Promise<SendResult> {
    if (!text) throw new CoreError(400, 'empty message');
    const target = await this.resume(ref);
    this.remember(text);
    const state = target.resumed ? await this.tick() : await this.current();
    return this.withInput<SendResult>(target.uid, async () => {
      const w = state.windows.find((w) => w.id === target.windowId);
      const queue = this.queue(target.uid);
      // Shells take input immediately (a dev server is always "busy"); agents get queued while working.
      const ready = !target.resumed && w && queue.length === 0 && (!w.agent || (!this.justSent(w.uid) && (w.status === 'idle' || w.status === 'attention')));
      if (ready) {
        if (w.agent) this.sentAt.set(w.uid, Date.now());
        await t.pasteText(target.windowId, text, enter);
        if (launchChange) this.applyLaunchChange(target.uid, launchChange);
        return { outcome: 'delivered', windowId: target.windowId, resumed: false, queued: 0 };
      }
      queue.push({ id: randomUUID().slice(0, 8), text, enter, at: now(), ...(launchChange ? { launchChange } : {}) });
      this.registry.setMeta(target.uid, 'ah.queue', queue);
      return { outcome: 'queued', windowId: target.windowId, resumed: target.resumed, queued: queue.length };
    });
  }

  private applyLaunchChange(uid: string, change: LaunchChange) {
    if (change.model !== undefined) this.registry.setMeta(uid, 'ah.launch.model', change.model);
    if (change.effort !== undefined) this.registry.setMeta(uid, 'ah.launch.effort', change.effort);
  }

  private justSent(uid: string): boolean {
    return Date.now() - (this.sentAt.get(uid) ?? 0) < 5000;
  }

  /** Serialize paste + Enter as one operation per session, across every caller. */
  private async withInput<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.inputs.get(uid) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(fn);
    this.inputs.set(uid, task);
    try {
      return await task;
    } finally {
      if (this.inputs.get(uid) === task) this.inputs.delete(uid);
    }
  }

  /** Recently sent prompts, newest first, shared by every device (resend from history). */
  recentPrompts() {
    return this.prompts;
  }

  /** Load persisted prompts (boot only — the table is read once, then mirrored). */
  async loadPrompts(): Promise<void> {
    this.prompts = await this.promptStore.load();
  }

  clearPrompts() {
    this.prompts = [];
    this.promptStore.clear();
  }

  private remember(text: string) {
    // Prompts can hold pasted secrets; keep only as many as configured (0 = none).
    const keep = this.config.promptHistory;
    if (keep <= 0) return;
    this.prompts = [{ text, at: now() }, ...this.prompts.filter((p) => p.text !== text)].slice(0, keep);
    this.promptStore.save(this.prompts);
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
      await this.withInput(w.uid, async () => {
        if (this.justSent(w.uid)) return;
        const [next, ...rest] = this.queue(w.uid);
        if (!next) return;
        // Remove before typing: at-most-once, never a duplicate turn (F16).
        this.registry.setMeta(w.uid, 'ah.queue', rest.length ? rest : undefined);
        this.sentAt.set(w.uid, Date.now());
        try {
          await t.pasteText(w.id, next.text, next.enter);
          if (next.launchChange) this.applyLaunchChange(w.uid, next.launchChange);
        } catch (err) {
          console.error(`queue delivery to ${w.id} failed:`, err);
        }
        w.queued = rest.length;
        w.status = 'busy';
      });
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

  /**
   * Switches model/effort in a live session by typing the agent's own command
   * ("/model opus"), built from a validated catalog id — never free text. Goes
   * through send(), so a busy agent gets it queued for its next idle moment.
   */
  async switchLaunch(uid: string, change: { model?: string; effort?: string }): Promise<SendResult> {
    if (Number(change.model !== undefined) + Number(change.effort !== undefined) !== 1) throw new CoreError(400, 'choose one setting to switch');
    const state = await this.current();
    const w = state.windows.find((w) => w.uid === uid);
    if (!w?.agent) throw new CoreError(404, 'no agent session');
    const preset = await withCatalog(this.preset(w.agent));
    let text: string;
    if (change.model !== undefined) {
      const model = preset.models?.find((m) => m.id === change.model) ?? customModel(preset, change.model);
      if (!model) throw new CoreError(400, `unknown model: ${change.model}`);
      if (!preset.switchModel) throw new CoreError(400, `${preset.name} can't switch models mid-session; start a new one`);
      text = preset.switchModel.replace('{model}', model.id);
    } else if (change.effort !== undefined) {
      const model = preset.models?.find((m) => m.id === (w.launchModel ?? preset.defaultModel));
      const levels = model?.efforts ?? preset.effort?.levels ?? [];
      if (!levels.includes(change.effort)) throw new CoreError(400, `unsupported effort: ${change.effort}`);
      if (!preset.switchEffort) throw new CoreError(400, `${preset.name} can't change effort mid-session; start a new one`);
      text = preset.switchEffort.replace('{level}', change.effort);
    } else {
      throw new CoreError(400, 'nothing to switch');
    }
    return this.send(uid, text, true, change);
  }

  async openSettings(uid: string, setting: 'model' | 'effort' | 'mode'): Promise<SendResult> {
    const w = (await this.current()).windows.find((w) => w.uid === uid);
    if (!w?.agent) throw new CoreError(404, 'no agent session');
    const preset = this.preset(w.agent);
    const command = preset.settingsCommands?.[setting];
    if (!command) throw new CoreError(400, `${preset.name} has no live ${setting} picker configured`);
    return this.send(uid, command, true);
  }

  /** Stop button: interrupts the agent's current turn (Esc for agents, Ctrl-C for shells). */
  async interrupt(uid: string) {
    const state = await this.current();
    const w = state.windows.find((w) => w.uid === uid);
    if (!w) throw new CoreError(404, 'session not found');
    await t.tmux('send-keys', '-t', w.id, ...this.interruptKeys(w));
    this.tick().catch(() => {});
  }

  private interruptKeys(w: WindowView): string[] {
    return (w.agent ? this.config.presets.find((p) => p.id === w.agent)?.interruptKeys : undefined) ?? (w.agent ? ['Escape'] : ['C-c']);
  }

  /**
   * Urgent follow-up: pulls one queued message out and delivers it now,
   * stopping the current turn first. The rest of the queue is untouched.
   */
  async sendNow(uid: string, itemId: string): Promise<SendResult> {
    const state = await this.current();
    const w = state.windows.find((w) => w.uid === uid);
    if (!w) throw new CoreError(404, 'session is not running');
    return this.withInput<SendResult>(uid, async () => {
      const items = this.queue(uid);
      const at = items.findIndex((q) => q.id === itemId);
      if (at < 0) throw new CoreError(404, 'queued message not found');
      const [next] = items.splice(at, 1);
      // Remove before typing: at-most-once, never a duplicate turn (F16).
      this.registry.setMeta(uid, 'ah.queue', items.length ? items : undefined);
      // Stop the live turn so the urgent message replaces it; idle sessions
      // need no interruption (a stray Esc/C-c could hit the wrong thing).
      if (w.status === 'busy' || w.status === 'waiting') {
        await t.tmux('send-keys', '-t', w.id, ...this.interruptKeys(w));
      }
      if (w.agent) this.sentAt.set(uid, Date.now());
      await t.pasteText(w.id, next.text, next.enter);
      if (next.launchChange) this.applyLaunchChange(uid, next.launchChange);
      this.tick().catch(() => {});
      return { outcome: 'delivered', windowId: w.id, resumed: false, queued: items.length };
    });
  }

  // ---------- small mutations

  setPinned(ref: string, pinned: boolean) {
    if (!this.registry.get(ref)) throw new CoreError(404, 'only sessions ah has run can be pinned');
    this.registry.setMeta(ref, 'ah.pinned', pinned || undefined);
    this.tick().catch(() => {});
  }

  /**
   * Manual sidebar order (F43). Sparse keys: existing orders keep their gaps,
   * so inserting between two sessions never rewrites every record.
   */
  setOrder(uid: string, order: number) {
    const rec = this.registry.get(uid);
    if (!rec) throw new CoreError(404, 'only sessions ah has run can be reordered');
    if (!Number.isFinite(order)) throw new CoreError(400, 'invalid order');
    this.registry.setMeta(uid, 'ah.order', order);
    this.tick().catch(() => {});
  }

  /** Next order key: max existing + 100, so new sessions land at the end. */
  nextOrder(): number {
    let max = 0;
    for (const r of this.registry.all()) {
      const o = r.meta['ah.order'];
      if (typeof o === 'number' && Number.isFinite(o) && o > max) max = o;
    }
    return max + 100 || 100;
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

  /**
   * Transcripts the full-text search index reads (issue #9): every discovered
   * conversation whose harness has a feed adapter, addressed by its registry
   * id when ah ran it and by `harness:harnessId` otherwise.
   */
  async searchSources(): Promise<TranscriptSource[]> {
    const transcripts = await discover();
    const out: TranscriptSource[] = [];
    for (const t of transcripts) {
      const adapter = this.config.presets.find((p) => p.id === t.harness)?.feed;
      if (!adapter) continue;
      const rec = this.registry.all().find((r) => r.harness === t.harness && r.harnessId === t.harnessId);
      out.push({
        file: t.file,
        harness: t.harness,
        adapter,
        harnessId: t.harnessId,
        ref: rec?.id ?? `${t.harness}:${t.harnessId}`,
        uid: rec?.id ?? null,
        title: t.title,
        cwd: t.cwd,
        model: t.model,
      });
    }
    return out;
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
