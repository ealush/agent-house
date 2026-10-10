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
import { Registry, forkMetaOf, type ForkMeta, type SessionRecord } from './registry.ts';
import { copyTranscript, forkUnavailableReason, removeCopiedTranscript, ForkError } from './fork.ts';
import { PromptStore } from './prompts.ts';
import { discover } from './discovery.ts';
import { expandHome, isExecutableOnPath, type Config, type Preset } from './config.ts';
import { buildLaunch, customModel, resumeSelection, LaunchError } from './launch.ts';
import { withCatalog } from './catalog.ts';
import * as t from './tmux.ts';
import { createSnapshot, restoreSnapshot as restoreSnapshotFiles, snapshotDiff, deleteSnapshotRef, createWorktree, headInfo, listWorktrees, mainRepo, removeWorktree, removeWorktreesBulk, GitError, type Worktree } from './git.ts';
import { invalidateSize } from './size.ts';
import { SnapshotStore, type SnapshotInfo } from './snapshots.ts';
import { QueueManager, type LaunchChange, type QueueItem } from './queue.ts';
import { Push } from './push.ts';
import { omarchyStamp } from './omarchy.ts';
import { claudeQuestionGroups, cursorKeys, dialogAt, dialogSteps, parsePicker, parseQuestionDialog, type Answer, type Step } from './choices.ts';
import type { Peers } from './peers.ts';
import type { TranscriptSource } from './search.ts';

export type { LaunchChange, QueueItem } from './queue.ts';

export type Host = { name: string; self: boolean; online: boolean };

/** Bumped when the state shape or API routes change, so a newer page can tell an older server apart. */
export const API_VERSION = 19;

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
  /** The desktop's Omarchy theme (name and change time), for clients that follow it. */
  omarchy: { name: string; at: number; font: string | null } | null;
};

export type SendResult = { outcome: 'delivered' | 'queued'; windowId: string; resumed: boolean; queued: number; queueId?: string };

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
  prompt: SendResult['outcome'] | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  /** Durable prompt queue (F22): state and flush policy live in server/queue.ts. */
  private queues: QueueManager;
  readonly push = new Push();
  readonly viewers: Map<string, string[]>;
  private state: State | null = null;
  private json = '';
  private listeners = new Set<(json: string) => void>();
  private tmuxPath = process.env.PATH ?? '';
  private ticking: Promise<State> | null = null;
  private stopped = false;
  private hidden = new Set<string>();
  private prompts: Array<{ text: string; at: number }> = [];
  private promptStore: PromptStore;
  private config: Config;
  private resuming = new Map<string, Promise<{ uid: string; windowId: string; resumed: boolean }>>();
  private inputs = new Map<string, Promise<unknown>>();
  private sentAt = new Map<string, number>();
  private snapshotStore: SnapshotStore;
  private snapLocks = new Map<string, Promise<unknown>>();
  /** Sessions inside a turn (busy or waiting on a prompt): one snapshot per turn, taken at its start. */
  private turnPeriod = new Set<string>();
  private lastPrune = 0;
  peers: Peers | null = null;

  constructor(config: Config, viewers: Map<string, string[]>, registry = new Registry(), prompts = new PromptStore(), snapshots = new SnapshotStore()) {
    this.registry = registry;
    this.promptStore = prompts;
    this.snapshotStore = snapshots;
    this.config = config;
    this.viewers = viewers;
    this.queues = new QueueManager(this.registry, {
      withInput: (uid, fn) => this.withInput(uid, fn),
      justSent: (uid) => this.justSent(uid),
      markSent: (uid) => void this.sentAt.set(uid, Date.now()),
      captureTurnStart: (uid, text) => this.captureTurnStart(uid, text),
      paste: (windowId, text, enter) => t.pasteText(windowId, text, enter),
      applyLaunchChange: (uid, change) => this.applyLaunchChange(uid, change),
    });
    try {
      if (existsSync(HIDDEN_FILE)) this.hidden = new Set(JSON.parse(readFileSync(HIDDEN_FILE, 'utf8')));
    } catch {}
  }

  start() {
    this.refreshTmuxPath();
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      this.tick().catch((err) => console.error('tick failed:', err)).finally(() => setTimeout(loop, TICK_MS));
    };
    loop();
  }

  /** Stop scheduling ticks (shutdown). An in-flight tick finishes on its own. */
  stop() {
    this.stopped = true;
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
      // Turn boundaries for snapshots (F39): entering busy/waiting from any
      // other state starts a turn, but only hook status is exact enough to
      // trust (activity-based busy also fires for a TUI merely drawing). The
      // send path captures too (it knows the prompt, and is the fallback for
      // agents without hooks); turnPeriod dedupes the two.
      for (const w of windows) {
        if (!w.agent) continue;
        if (w.status === 'busy' || w.status === 'waiting') {
          if (w.statusSource === 'hook' && !this.turnPeriod.has(w.uid)) void this.captureTurnStart(w.uid, '');
        } else this.turnPeriod.delete(w.uid);
      }
      if (now() - this.lastPrune > 3600) {
        this.lastPrune = now();
        void this.pruneSnapshots().catch((err) => console.error('snapshot prune failed:', err));
      }
      await this.queues.deliverDue(windows);
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
        omarchy: omarchyStamp(),
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

  async launch(o: {
    preset: Preset;
    cwd: string;
    session: string;
    name: string;
    command: string;
    uid?: string;
    harnessId?: string;
    pendingResume?: boolean;
    meta?: Record<string, unknown>;
    /** Runs once the window exists and is registered, just before the command is typed. */
    beforeCommand?: () => Promise<void>;
  }) {
    const uid = o.uid ?? Registry.newId();
    let meta = o.meta;
    // A new agent conversation has no id yet: snapshot the transcript ids that
    // already exist so adoption binds by novelty (session identity), never by
    // recency. Taken before the agent starts, so its own transcript is novel.
    if (!o.harnessId && o.preset.feed) {
      try {
        const known = (await discover()).filter((x) => x.harness === o.preset.id).map((x) => x.harnessId);
        meta = { ...meta, 'ah.knownTranscripts': known };
      } catch {}
    }
    const windowId = await t.createWindow({ session: o.session, cwd: o.cwd, name: o.name });
    try {
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
        meta,
      });
      await o.beforeCommand?.();
      if (o.command) await t.sendLine(windowId, o.command);
      this.tick().catch(() => {});
      return { uid, windowId };
    } catch (err) {
      await t.killWindow(windowId).catch(() => {});
      this.registry.remove(uid);
      throw err;
    }
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

  // ---------- fork (F36): duplicate the conversation into its own worktree session

  /** The parent a fork would copy: a registry record, or a discovered conversation. */
  private async forkParent(ref: string): Promise<{ uid: string; rec?: SessionRecord; harness: string; harnessId?: string; cwd: string; title: string }> {
    const rec = this.registry.get(ref);
    if (rec) return { uid: rec.id, rec, harness: rec.harness, harnessId: rec.harnessId, cwd: rec.cwd, title: rec.title };
    const i = ref.indexOf(':');
    if (i > 0) {
      const found = (await discover()).find((x) => x.harness === ref.slice(0, i) && x.harnessId === ref.slice(i + 1));
      if (found) return { uid: ref, harness: found.harness, harnessId: found.harnessId, cwd: found.cwd, title: found.title };
    }
    throw new CoreError(404, 'session not found');
  }

  /** What the fork dialog needs to know before anything is created. */
  async forkInfo(ref: string): Promise<ForkInfo> {
    const parent = await this.forkParent(ref);
    const reason = forkUnavailableReason(parent.harness, parent.harnessId);
    const head = await headInfo(expandHome(parent.cwd)).catch(() => null);
    const state = await this.current();
    const live = parent.rec ? state.windows.find((w) => w.uid === parent.rec!.id) : undefined;
    const sel = parent.rec ? resumeSelection(parent.rec.meta as Record<string, unknown>) : {};
    const preset = this.config.presets.find((p) => p.id === parent.harness);
    const mode = sel.mode ? preset?.modes?.find((m) => m.id === sel.mode) : undefined;
    return {
      canFork: !reason && !!head?.head,
      reason: reason ?? (head?.head ? null : 'forking needs a git repository with at least one commit: two sessions in one checkout would overwrite each other'),
      harness: parent.harness,
      title: parent.title,
      suggestedName: `${parent.title} (fork)`,
      branch: head?.branch ?? null,
      head: head?.head ? head.head.slice(0, 7) : null,
      dirty: head?.dirty ?? 0,
      busy: live?.status === 'busy',
      mode: sel.mode ?? null,
      model: sel.model ?? null,
      effort: sel.effort ?? null,
      dangerous: !!mode?.dangerous,
    };
  }

  /**
   * Forks a session: copies its transcript to a new conversation id homed in a
   * fresh worktree, then resumes the copy there. The parent is never touched.
   * A working parent is waited out (its transcript is mid-write); the copy,
   * the worktree and the launch roll back as one if anything fails midway.
   */
  async fork(ref: string, o: { name?: string; prompt?: string; model?: string; effort?: string; mode?: string } = {}): Promise<ForkResult> {
    const parent = await this.forkParent(ref);
    const reason = forkUnavailableReason(parent.harness, parent.harnessId);
    if (reason) throw new CoreError(422, reason);

    // Wait for the live turn to end: the transcript is only consistent between turns.
    if (parent.rec) {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const state = await this.current();
        const live = state.windows.find((w) => w.uid === parent.rec!.id);
        if (!live || live.status !== 'busy') break;
        if (Date.now() > deadline) throw new CoreError(409, 'the session is still working; a fork starts when its current turn ends, so try again shortly');
        await sleep(500);
        await this.tick().catch(() => {});
      }
    }

    const preset = await withCatalog(this.preset(parent.harness));
    try {
      buildLaunch(preset, { mode: o.mode, model: o.model, effort: o.effort });
    } catch (err) {
      throw new CoreError(400, (err as Error).message);
    }
    await this.tick();
    const { copied, wt, head, name } = await this.withInput(parent.uid, async () => {
      const live = (await this.current()).windows.find((w) => w.uid === parent.uid);
      const found = (await discover()).find((x) => x.harness === parent.harness && x.harnessId === parent.harnessId);
      if (!found) throw new CoreError(422, 'no transcript found for this conversation; it may have been cleared or rotated');

      const cwd = expandHome(parent.cwd);
      const head = await headInfo(cwd).catch(() => null);
      if (!head?.head) throw new CoreError(422, 'forking needs a git repository with at least one commit: two sessions in one checkout would overwrite each other');
      if (live && (live.status === 'busy' || this.justSent(parent.uid))) throw new CoreError(409, 'the parent started another turn; try forking when it finishes');

      const name = (o.name?.trim() || `${parent.title} (fork)`).slice(0, 80);
      let wt: Worktree;
      try {
        wt = await createWorktree(cwd, name, head.head);
      } catch (err) {
        if (err instanceof GitError) throw new CoreError(400, err.message);
        throw err;
      }

      let copied: { harnessId: string; file: string };
      try {
        copied = await copyTranscript(parent.harness, found.file, wt.path);
      } catch (err) {
        await removeWorktree(wt.path, true).catch(() => {});
        if (err instanceof ForkError) throw new CoreError(err.status, err.message);
        throw new CoreError(500, `fork failed while copying the conversation: ${(err as Error).message}`);
      }
      return { copied, wt, head, name };
    });

    const inherited = parent.rec ? resumeSelection(parent.rec.meta as Record<string, unknown>) : {};
    const sel = { mode: o.mode ?? inherited.mode, model: o.model ?? inherited.model, effort: o.effort ?? inherited.effort };
    let command: string;
    let launchMeta: Record<string, unknown>;
    try {
      const plan = buildLaunch(preset, { ...sel, resume: copied.harnessId });
      command = plan.command;
      launchMeta = { ...plan.meta };
    } catch (err) {
      await removeCopiedTranscript(copied.file);
      await removeWorktree(wt.path, true).catch(() => {});
      throw new CoreError(400, (err as Error).message);
    }
    const parentFork: ForkMeta | null = parent.rec ? forkMetaOf(parent.rec) : null;
    const forkMeta: ForkMeta = {
      parentUid: parent.uid,
      rootUid: parentFork?.rootUid ?? parent.uid,
      rootTitle: parentFork?.rootTitle ?? parent.title,
      forkedAt: now(),
      forkSeq: this.registry.forksOf(parent.uid).length + 1,
    };
    let session = this.config.defaultSession;
    if (parent.rec?.tmux?.session && (await t.hasSession(parent.rec.tmux.session))) session = parent.rec.tmux.session;
    let out: { uid: string; windowId: string };
    try {
      out = await this.launch({
        preset,
        cwd: wt.path,
        session,
        name,
        command,
        harnessId: copied.harnessId,
        pendingResume: true,
        meta: { ...launchMeta, 'ah.worktree': wt, 'ah.order': this.nextOrder(), 'ah.fork': forkMeta },
      });
    } catch (err) {
      await removeCopiedTranscript(copied.file);
      await removeWorktree(wt.path, true).catch(() => {});
      throw err;
    }

    let prompt: SendResult['outcome'] | null = null;
    if (o.prompt?.trim()) {
      prompt = await this.send(out.uid, o.prompt.trim()).then((r) => r.outcome).catch(() => null);
    }
    this.tick().catch(() => {});
    return { uid: out.uid, id: out.windowId, harnessId: copied.harnessId, worktree: wt.path, branch: wt.branch, base: head.head.slice(0, 7), prompt };
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
      const queued = this.queues.items(target.uid);
      // A waiting agent is blocked on your input: what you send now is the
      // answer to its question or approval prompt, so it is typed immediately
      // instead of queued behind the turn that asked. (The ticker never flushes
      // the queue into a waiting session, so queueing here would strand it.)
      // Shells take input immediately (a dev server is always "busy"); agents get queued while working.
      const answering = !!w?.agent && w.status === 'waiting';
      const ready = !target.resumed && !!w && (answering || queued.length === 0) && (answering || !w.agent || (!this.justSent(w.uid) && (w.status === 'idle' || w.status === 'attention')));
      if (ready) {
        if (w.agent) {
          this.sentAt.set(w.uid, Date.now());
          // Snapshot before the prompt lands, so the turn starts from a known state (F39).
          if (enter) await this.captureTurnStart(target.uid, text);
        }
        await t.pasteText(target.windowId, text, enter);
        if (launchChange) this.applyLaunchChange(target.uid, launchChange);
        return { outcome: 'delivered', windowId: target.windowId, resumed: false, queued: 0 };
      }
      const item: QueueItem = {
        id: randomUUID().slice(0, 8),
        text,
        enter,
        at: now(),
        ...(launchChange ? { launchChange } : {}),
      };
      const queuedCount = this.queues.enqueue(target.uid, item);
      return { outcome: 'queued', windowId: target.windowId, resumed: target.resumed, queued: queuedCount, queueId: item.id };
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

  /** A copy of the session's queued items, oldest first (state lives in the QueueManager). */
  queue(uid: string): QueueItem[] {
    return this.queues.items(uid);
  }

  /** Drop one queued item or the whole queue. */
  clearQueue(uid: string, itemId?: string) {
    this.queues.clear(uid, itemId);
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
   * Picks one row of a numbered picker on screen (a permission prompt's "Yes, and
   * don't ask again"). The key must be one the fresh screen still offers.
   */
  async choose(uid: string, key: string) {
    const state = await this.tick();
    const w = state.windows.find((w) => w.uid === uid);
    if (!w) throw new CoreError(404, 'session not found');
    if (w.status !== 'waiting') throw new CoreError(409, 'it is no longer waiting');
    if (!w.ask?.options?.some((o) => o.key === key)) throw new CoreError(409, 'that choice is no longer on screen');
    // Read the screen again inside the input lock: the picker must still be there,
    // and a cursor list is moved from where its cursor is now.
    const option = await this.withInput(uid, async () => {
      const lines = (await t.capturePane(w.id, 0).catch(() => '')).split('\n').map((l) => l.trimEnd());
      const picker = parsePicker(lines.filter((l) => l.trim()).slice(-40));
      const found = picker?.options.find((o) => o.key === key);
      if (!picker || !found) throw new CoreError(409, 'that choice is no longer on screen');
      const keys = key.startsWith('nav:') ? cursorKeys(picker.cursor ?? 0, Number(key.slice(4))) : [key];
      await t.tmux('send-keys', '-t', w.id, ...keys);
      return found;
    });
    this.tick().catch(() => {});
    return option;
  }

  /**
   * Answers the agent's question dialog (Claude's AskUserQuestion) as a whole, from
   * the questions its hook recorded. Each question's keys go in only once the
   * screen shows that question untouched (and the submit only on the review), so
   * input from elsewhere mid-way stops the answer instead of misplacing it.
   */
  async answerQuestions(uid: string, answers: Answer[]) {
    const w = await this.askingWindow(uid);
    const questions = w.ask?.questions;
    if (!questions) throw new CoreError(409, 'the question on screen has changed; answer it again');
    const groups = this.stepsOr400(() => claudeQuestionGroups(questions, answers));
    await this.typeChecked(
      w,
      groups.map((steps, i) => ({
        steps,
        ready: (screen: string) => dialogAt(screen, questions, i),
        stale: i === 0 ? 'the question on screen has changed; answer it again' : `the dialog changed while answering (input from somewhere else?): stopped after ${i} of ${questions.length}; finish it in the terminal`,
      })),
    );
  }

  /**
   * Answers the one question the dialog shows now (windows without hooks, or a
   * dialog already half answered in the terminal). `question` is the text the
   * caller saw; a different question on screen means its answer is stale.
   */
  async answerDialogQuestion(uid: string, question: string, answer: Answer) {
    const w = await this.askingWindow(uid);
    let steps: Step[] = [];
    await this.typeChecked(w, [
      {
        steps: () => steps,
        ready: (screen: string) => {
          const dialog = parseQuestionDialog(screen.split('\n').map((l) => l.trimEnd()));
          if (!dialog || dialog.question !== question) return false;
          steps = this.stepsOr400(() => dialogSteps(dialog, answer));
          return true;
        },
        stale: 'the question on screen has changed; answer it again',
      },
    ]);
  }

  private async askingWindow(uid: string) {
    const state = await this.tick();
    const w = state.windows.find((w) => w.uid === uid);
    if (!w?.agent) throw new CoreError(404, 'session not found');
    if (w.status !== 'waiting' || w.ask?.kind !== 'choice') throw new CoreError(409, 'it is no longer asking');
    if (this.preset(w.agent).questions !== 'claude') throw new CoreError(400, `answer ${w.agent} in its terminal`);
    return w;
  }

  private stepsOr400<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      throw new CoreError(400, (e as Error).message);
    }
  }

  /**
   * Types groups of keys into a window inside its input lock, re-reading the
   * screen before each group: a group goes in only when `ready` holds (waiting
   * up to ~1s for the agent to redraw after the previous group), else the
   * answer stops with `stale`. tmux can't reserve a pane for one client (input
   * off blocks send-keys too), so this keeps any mix-up to one group's keys.
   */
  private async typeChecked(w: WindowView, groups: Array<{ steps: Step[] | (() => Step[]); ready: (screen: string) => boolean; stale: string }>) {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await this.withInput(w.uid, async () => {
      for (const group of groups) {
        let ok = false;
        for (let tries = 0; tries < 12 && !ok; tries++) {
          if (tries) await sleep(90);
          ok = group.ready(await t.capturePane(w.id, 0).catch(() => ''));
        }
        if (!ok) throw new CoreError(409, group.stale);
        for (const step of typeof group.steps === 'function' ? group.steps() : group.steps) {
          if ('text' in step) await t.tmux('send-keys', '-t', w.id, '-l', step.text);
          else await t.tmux('send-keys', '-t', w.id, ...step.keys);
          // Ink redraws between keys; a key that lands mid-render can be dropped.
          await sleep(90);
        }
      }
    });
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

  /**
   * Hot swap: restart an idle session with a different model/effort while
   * keeping the same conversation. Unlike switchLaunch (which types a live
   * command), this kills the window and resumes the same harness
   * conversation with new launch flags — the path for agents without a
   * live-switch command. The queue follows the conversation id via
   * inheritQueue; snapshots are rekeyed to the replacement session.
   */
  async relaunch(uid: string, change: { model?: string; effort?: string }): Promise<{ uid: string; id: string }> {
    if (Number(change.model !== undefined) + Number(change.effort !== undefined) !== 1) throw new CoreError(400, 'choose one setting to relaunch with');
    const state = await this.current();
    const w = state.windows.find((w) => w.uid === uid);
    if (!w?.agent) throw new CoreError(404, 'no agent session');
    if (w.status === 'busy' || w.status === 'waiting' || w.queued > 0 || this.justSent(uid)) {
      throw new CoreError(409, 'relaunch when the session is idle; it is working, waiting or holding queued prompts');
    }
    const rec = this.registry.get(uid);
    const harnessId = w.harnessId ?? rec?.harnessId;
    if (!harnessId) throw new CoreError(422, 'this session has no conversation id yet, so there is nothing to resume');
    const preset = await withCatalog(this.preset(w.agent));
    let model: string | undefined;
    let effort: string | undefined;
    if (change.model !== undefined) {
      // customModel throws LaunchError on malformed ids; the HTTP layer only
      // maps CoreError, so convert here instead of leaking a 500.
      // customModel throws LaunchError on malformed ids; the HTTP layer only
      // maps CoreError, so convert here instead of leaking a 500.
      let found;
      try {
        found = preset.models?.find((m) => m.id === change.model) ?? customModel(preset, change.model);
      } catch (err) {
        throw new CoreError(400, (err as Error).message);
      }
      if (!found) throw new CoreError(400, `unknown model: ${change.model}`);
      model = found.id;
    } else {
      const current = preset.models?.find((m) => m.id === (w.launchModel ?? preset.defaultModel));
      const levels = current?.efforts ?? preset.effort?.levels ?? [];
      if (!preset.effort || !levels.includes(change.effort!)) {
        throw new CoreError(400, preset.effort ? `unsupported effort: ${change.effort}` : `${preset.name} has no effort setting`);
      }
      effort = change.effort;
    }
    const inherited = rec ? resumeSelection(rec.meta as Record<string, unknown>) : {};
    const sel = { ...inherited, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
    let plan;
    try {
      plan = buildLaunch(preset, { ...sel, resume: harnessId });
    } catch (err) {
      throw new CoreError(400, (err as Error).message);
    }
    const cwd = expandHome(rec?.cwd ?? w.cwd);
    let session = this.config.defaultSession;
    if (rec?.tmux?.session && (await t.hasSession(rec.tmux.session))) session = rec.tmux.session;
    // The replacement keeps what belongs to the session, not the process: its
    // pin, sidebar place, worktree and fork lineage. Launch choices are new.
    const { 'ah.queue': _queue, 'ah.knownTranscripts': _known, ...kept } = (rec?.meta ?? {}) as Record<string, unknown>;
    // New window first: if it can't be created, the running session is untouched.
    // The old agent stops only then, before the new one resumes the conversation,
    // so the two never run it at once.
    const out = await this.launch({
      preset,
      cwd: (await isDir(cwd)) ? cwd : homedir(),
      session,
      name: w.title,
      command: plan.command,
      harnessId,
      pendingResume: true,
      meta: { ...kept, ...plan.meta },
      // The old agent must be gone before the new one resumes the conversation:
      // if it won't stop, the relaunch fails (launch removes the new window)
      // rather than run two agents on one conversation. Already gone is fine.
      beforeCommand: async () => {
        try {
          await t.killWindow(w.id);
        } catch {
          if (await t.windowExists(w.id).catch(() => null)) throw new CoreError(409, "the old window wouldn't stop, so the relaunch was cancelled; nothing changed");
        }
      },
    });
    await this.snapshotStore.rekey(uid, out.uid).catch(() => {});
    const snap = rec?.meta['ah.snapshots'];
    if (snap !== undefined) this.registry.setMeta(out.uid, 'ah.snapshots', snap);
    this.tick().catch(() => {});
    return { uid: out.uid, id: out.windowId };
  }

  /** A live session's agent preset and absolute working directory (composer autocomplete). */
  async sessionPlace(uid: string): Promise<{ preset: Preset | null; cwd: string }> {
    const w = (await this.current()).windows.find((w) => w.uid === uid);
    if (!w) throw new CoreError(404, 'session not found');
    return { preset: w.agent ? this.preset(w.agent) : null, cwd: expandHome(this.registry.get(uid)?.cwd ?? w.cwd) };
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
      const taken = this.queues.take(uid, itemId);
      if (!taken) throw new CoreError(404, 'queued message not found');
      const { next, rest } = taken;
      // Stop the live turn so the urgent message replaces it; idle sessions
      // need no interruption (a stray Esc/C-c could hit the wrong thing).
      if (w.status === 'busy' || w.status === 'waiting') {
        await t.tmux('send-keys', '-t', w.id, ...this.interruptKeys(w));
      }
      if (w.agent) {
        this.sentAt.set(uid, Date.now());
        // The interrupted turn is over; this delivery starts a new one (F39).
        this.turnPeriod.delete(uid);
        if (next.enter) await this.captureTurnStart(uid, next.text);
      }
      await t.pasteText(w.id, next.text, next.enter);
      if (next.launchChange) this.applyLaunchChange(uid, next.launchChange);
      this.tick().catch(() => {});
      return { outcome: 'delivered', windowId: w.id, resumed: false, queued: rest.length };
    });
  }

  // ---------- per-turn snapshots (F39)

  private snapConfig() {
    return { maxFileBytes: this.config.snapshots?.maxFileBytes ?? 10 * 1024 * 1024, keepTurns: this.config.snapshots?.keepTurns ?? 50, retentionDays: this.config.snapshots?.retentionDays ?? 7 };
  }

  private snapSettings(uid: string): { enabled: boolean; lastTurn: number } {
    const s = this.registry.get(uid)?.meta['ah.snapshots'] as { enabled?: unknown; lastTurn?: unknown } | undefined;
    return { enabled: this.config.snapshots?.enabled !== false && s?.enabled !== false, lastTurn: typeof s?.lastTurn === 'number' ? s.lastTurn : 0 };
  }

  /** Serialize snapshot work per session: captures and restores never overlap. */
  private async withSnap<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.snapLocks.get(uid) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(fn);
    this.snapLocks.set(uid, task);
    try {
      return await task;
    } finally {
      if (this.snapLocks.get(uid) === task) this.snapLocks.delete(uid);
    }
  }

  /**
   * Marks the start of a turn and captures its pre-turn snapshot. Called from
   * the send path (which knows the prompt and runs before the paste) and from
   * the ticker's status transitions (terminal-typed turns, where the prompt
   * is unknown). One capture per turn period; failures are silent because a
   * snapshot must never block or break a turn.
   */
  captureTurnStart(uid: string, promptText: string): Promise<SnapshotInfo | null> {
    if (this.turnPeriod.has(uid)) return Promise.resolve(null);
    this.turnPeriod.add(uid);
    return this.captureSnapshot(uid, 'turn', promptText).catch((err) => {
      console.error(`snapshot capture for ${uid} failed:`, err);
      return null;
    });
  }

  private async captureSnapshot(uid: string, kind: 'turn' | 'safety', promptText: string): Promise<SnapshotInfo | null> {
    return this.withSnap(uid, async () => {
      const rec = this.registry.get(uid);
      if (!rec || !rec.harness || rec.harness === 'shell') return null;
      const settings = this.snapSettings(uid);
      if (kind !== 'safety' && !settings.enabled) return null;
      const cwd = expandHome(rec.cwd);
      if (!(await isDir(cwd))) return null;
      const latest = await this.snapshotStore.latest(uid).catch(() => null);
      const turn = Math.max(settings.lastTurn, latest?.turn ?? 0) + 1;
      let made;
      try {
        made = await createSnapshot(cwd, {
          uid,
          turn,
          indexFile: join(STATE_DIR, 'snapshots', uid, `index-${turn}`),
          parent: latest?.commit ?? null,
          maxFileBytes: this.snapConfig().maxFileBytes,
        });
      } catch {
        return null; // not a git repo, or git refused: snapshots are unavailable here
      }
      const diff = await snapshotDiff(cwd, latest?.commit ?? null, made.commit).catch(() => ({ filesChanged: 0, insertions: 0, deletions: 0 }));
      const info = await this.snapshotStore.create({
        uid,
        turn,
        commit: made.commit,
        repoRoot: await mainRepo(cwd),
        kind,
        promptExcerpt: promptText.replace(/\s+/g, ' ').trim().slice(0, 120),
        branch: made.branch,
        createdAt: now(),
        ...diff,
        skipped: made.skipped,
        submodules: made.submodules,
      });
      this.registry.setMeta(uid, 'ah.snapshots', { enabled: settings.enabled, lastTurn: turn });
      return info;
    });
  }

  async listSnapshots(uid: string): Promise<{ snapshots: SnapshotInfo[]; enabled: boolean; available: boolean; partial: boolean; branch: string | null }> {
    const rec = this.registry.get(uid);
    if (!rec) throw new CoreError(404, 'session not found');
    const snapshots = await this.snapshotStore.list(uid).catch(() => []);
    const available = !!rec.harness && rec.harness !== 'shell' && await mainRepo(expandHome(rec.cwd)).then(() => true).catch(() => false);
    const w = (await this.current()).windows.find((x) => x.uid === uid);
    return {
      snapshots,
      enabled: this.snapSettings(uid).enabled,
      available,
      // Turns typed straight into the raw terminal are captured from status
      // transitions only when hooks report them exactly.
      partial: !!w?.agent && w.statusSource !== 'hook',
      branch: w?.branch ?? snapshots[0]?.branch ?? null,
    };
  }

  setSnapshotsEnabled(uid: string, enabled: boolean) {
    const rec = this.registry.get(uid);
    if (!rec) throw new CoreError(404, 'session not found');
    this.registry.setMeta(uid, 'ah.snapshots', { enabled, lastTurn: this.snapSettings(uid).lastTurn });
    if (!enabled) this.turnPeriod.delete(uid);
    this.tick().catch(() => {});
  }

  /**
   * Rolls the worktree back to a snapshot's pre-turn state. A safety snapshot
   * of the current state is taken first, so the restore is itself undoable.
   * Serialized with sends through the per-session input lock; a working agent
   * must be stopped first, or the caller confirms the interrupt.
   */
  async restoreSnapshot(uid: string, turn: number, opts: { interrupt?: boolean } = {}): Promise<{ safety: SnapshotInfo; restored: SnapshotInfo }> {
    const rec = this.registry.get(uid);
    if (!rec) throw new CoreError(404, 'session not found');
    const target = await this.snapshotStore.get(uid, turn).catch(() => null);
    if (!target) throw new CoreError(404, 'snapshot not found');
    // A just-finished turn can still read as busy for a few seconds (the
    // submit-protection window in tick): give a working agent a short grace
    // to finish on its own before calling it busy.
    let w = (await this.tick()).windows.find((x) => x.uid === uid);
    for (let i = 0; i < 12 && w && (w.status === 'busy' || w.status === 'waiting'); i++) {
      await new Promise((r) => setTimeout(r, 500));
      w = (await this.tick()).windows.find((x) => x.uid === uid);
    }
    const out = await this.withInput(uid, async () => {
      w = (await buildWindows(this.config, this.viewers, this.registry)).find((x) => x.uid === uid);
      if (w && (w.status === 'busy' || w.status === 'waiting' || this.justSent(uid))) {
        if (!opts.interrupt) throw new CoreError(409, 'the agent is working; stop it first or confirm the interrupt');
        await t.tmux('send-keys', '-t', w.id, ...this.interruptKeys(w));
        this.sentAt.delete(uid);
        for (let i = 0; i < 12; i++) {
          await sleep(500);
          w = (await buildWindows(this.config, this.viewers, this.registry)).find((x) => x.uid === uid);
          if (!w || (w.status !== 'busy' && w.status !== 'waiting')) break;
        }
        if (w && (w.status === 'busy' || w.status === 'waiting')) throw new CoreError(409, 'the agent is working; it did not stop after the interrupt');
      }
      this.turnPeriod.add(uid);
      const cwd = expandHome(rec.cwd);
      const safety = await this.captureSnapshot(uid, 'safety', `Before restoring turn ${turn}`);
      if (!safety) throw new CoreError(400, 'could not snapshot the current state; nothing was restored');
      try {
        await restoreSnapshotFiles(cwd, { target: target.commit, current: safety.commit, indexFile: join(STATE_DIR, 'snapshots', uid, 'index-restore') });
      } catch (err) {
        // Undo a partial checkout using the safety snapshot before reporting failure.
        await restoreSnapshotFiles(cwd, { target: safety.commit, current: target.commit, indexFile: join(STATE_DIR, 'snapshots', uid, 'index-recover') }).catch(() => {});
        throw new CoreError(400, `restore failed: ${(err as Error).message}`);
      }
      return { safety, restored: target };
    });
    // Told after the input lock is released (send takes the same lock): the
    // agent's picture of its files must not silently diverge from disk.
    if (w?.agent) {
      await this.send(uid, `Your files were rolled back to the state before turn ${turn} by the user. Run git status and re-read changed files before continuing.`, true).catch(() => {});
    }
    return out;
  }

  /**
   * Retention (F39): snapshots live for the session's life plus retentionDays
   * after it ends, and each session keeps at most keepTurns of them. Pruned
   * rows lose their git refs too, so their commits become collectable.
   */
  async pruneSnapshots(): Promise<void> {
    const { keepTurns, retentionDays } = this.snapConfig();
    const rows = await this.snapshotStore.all().catch(() => []);
    const byUid = new Map<string, SnapshotInfo[]>();
    for (const r of rows) byUid.set(r.uid, [...(byUid.get(r.uid) ?? []), r]);
    for (const [uid, list] of byUid) {
      const rec = this.registry.get(uid);
      const last = list[list.length - 1];
      const expired = rec?.endedAt
        ? now() - rec.endedAt > retentionDays * 86_400
        : !rec && last && now() - last.createdAt > retentionDays * 86_400;
      const doomed = expired ? list : list.slice(0, Math.max(0, list.length - keepTurns));
      for (const row of doomed) {
        const repo = row.repoRoot || (rec ? expandHome(rec.cwd) : null);
        if (repo) await deleteSnapshotRef(repo, uid, row.turn);
        await this.snapshotStore.remove(uid, row.turn).catch(() => {});
      }
    }
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
      const users = state.windows.filter((w) => this.usesWorktree(w, wt.path));
      const owners = this.registry.all().filter((r) => (r.meta['ah.worktree'] as Worktree | undefined)?.path === wt.path);
      return {
        ...wt,
        // The owning session's activity is the better "last used" signal when there is one.
        lastActivityAt: Math.max(wt.lastActivityAt, ...owners.map((r) => r.lastActivityAt)),
        live: users.map((w) => ({ id: w.id, name: w.name })),
        sessions: owners.map((r) => ({ id: r.id, title: r.title, lifecycle: r.lifecycle })),
        orphan: users.length === 0 && !owners.some((r) => !!r.harnessId || r.lifecycle === 'starting'),
      };
    });
  }

  async removeWorktree(path: string, force: boolean) {
    const state = await this.current();
    if (state.windows.some((w) => expandHome(w.cwd) === path || expandHome(w.cwd).startsWith(path + '/'))) {
      throw new CoreError(409, 'a live session is using this worktree');
    }
    await removeWorktree(path, force);
    invalidateSize(path);
  }

  /**
   * Bulk removal for the cleanup flow. In-use is re-checked per item against
   * a fresh state pass; everything else (managed root, dirty) is revalidated
   * inside the git layer at the moment of removal.
   */
  async removeWorktreesBulk(paths: string[], force: string[]) {
    return removeWorktreesBulk(paths, new Set(force), async (path) => {
      const state = await this.tick();
      return state.windows.some((w) => this.usesWorktree(w, path)) || this.registry.all().some((r) =>
        (r.meta['ah.worktree'] as Worktree | undefined)?.path === path && (!!r.harnessId || r.lifecycle === 'starting'),
      );
    });
  }

  private usesWorktree(w: WindowView, path: string): boolean {
    const cwd = expandHome(w.cwd);
    return cwd === path || cwd.startsWith(path + '/') ||
      (this.registry.get(w.uid)?.meta['ah.worktree'] as Worktree | undefined)?.path === path;
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
