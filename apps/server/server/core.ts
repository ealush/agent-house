// The host daemon's brain: a ticker that re-derives everything from tmux, the
// registry and the harnesses' own stores, plus the few verbs that change things
// (launch, resume, send). HTTP, SSE and the CLI are all thin views over this.
import type { ReviewState } from './review/service.ts';
import type { JobsState } from './jobs/scheduler.ts';
import type { RecoveryView } from './recovery/engine.ts';
import { hostName } from './host.ts';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { InterruptionsState } from './interruptions.ts';
import { LastReplies, type ReplyTarget } from './replies.ts';
import { SourceControl, type ScmTarget } from './scm.ts';
import { ahCommand, linkHints } from './sessionLinks.ts';
import { SubagentService, type Root as SubagentRoot } from './subagents/service.ts';
import { parseClaudeRef, type Harness as SubagentHarness, type SubagentTree } from './subagents/model.ts';
import { buildWindows, buildHistory, adoptTranscripts, chosenSpace, repoInfo, flagOnlyMode, footerMode, isQuestionDialog, projectOf, type WindowView, type HistoryItem } from './sessions.ts';
import { Registry, uidOfRef, type StartUndo, forkMetaOf, type ForkMeta, type SessionRecord } from './registry.ts';
import { copyTranscript, forkUnavailableReason, removeCopiedTranscript, ForkError } from './fork.ts';
import { PromptStore } from './prompts.ts';
import { claudeTranscriptOf, discover } from './discovery.ts';
import { expandHome, isExecutableOnPath, type Config, type Preset } from './config.ts';
import { buildLaunch, customModel, modelSwitch, resolvePermissionMode, resumesConversation, resumeSelection, LaunchError } from './launch.ts';
import { withCatalog } from './catalog.ts';
import { Harnesses, adjust, suggestions } from './harnesses.ts';
import { boxHolds } from './imagePaths.ts';
import * as t from './tmux.ts';
import { descendants, procTree } from './procs.ts';
import { restoreSnapshot as restoreSnapshotFiles, createWorktree, headInfo, listWorktrees, mainRepo, removeWorktree, removeWorktreesBulk, GitError, type Worktree } from './git.ts';
import { invalidateSize } from './size.ts';
import { SnapshotStore, type SnapshotInfo } from './snapshots.ts';
import { TurnSnapshots } from './turnSnapshots.ts';
import { QueueManager, starting, type LaunchChange, type QueueItem } from './queue.ts';
import { confirms, conversationHas, markConversation, type ConversationMark } from './feed/landed.ts';
import { picked } from './feed/picked.ts';
import { Push, askLine } from './push.ts';
import { omarchyStamp } from './omarchy.ts';
import { callbackFor, compileGates, readGate, type Gate, type GateKind } from './agentgate.ts';
import { chatSteps, claudeQuestionGroups, cursorKeys, dialogAt, dialogSteps, parsePicker, parseQuestionDialog, type Answer, type ScreenOption, type Step } from './choices.ts';
import type { Peers } from './peers.ts';
import type { Apns } from './apns.ts';
import { StateStream } from './stateStream.ts';
import { AnswerGuard } from './answers.ts';
import { fileURLToPath } from 'node:url';
import { renderRolePlaybook, type McpRole } from './mcp.ts';
import { ensureMcpConfigFile } from './mcpConfig.ts';
import {
  checkApprovalGuardrail,
  checkSessionControl,
  checkSupervisionMutation,
  chiefClaims,
  claimedBy,
  mergeSupervision,
  spaceOwners,
  supervisionGraph,
  supervisionOf,
  type ControlAction,
  type Supervision,
} from './supervision.ts';
import { fingerprint } from './env.ts';
import { features } from './features.ts';
import type { NotesState } from './notes/store.ts';
import type { SpacesState } from './spaces/model.ts';
import type { CheckoutsState } from './checkouts/model.ts';
import type { AcquiredCheckout, AcquiredResume, AcquireLaunchInput, ResumeAcquireInput } from './checkouts/service.ts';
import type { TranscriptSource } from './search.ts';
import { DomainError } from './errors.ts';

export type { LaunchChange, QueueItem } from './queue.ts';

export type Host = { name: string; self: boolean; online: boolean };

/** Bumped when the state shape or API routes change, so a newer page can tell an older server apart. */
export const API_VERSION = 28;

export type State = {
  api: number;
  hostname: string;
  hosts: Host[];
  home: string;
  defaultSession: string;
  sessions: string[];
  windows: WindowView[];
  history: HistoryItem[];
  /** `hidden`: kept out of New session on this host (Settings → Agents). */
  presets: Array<Preset & { available: boolean; hidden?: boolean }>;
  /** The desktop's Omarchy theme (name and change time), for clients that follow it. */
  omarchy: { name: string; at: number; font: string | null } | null;
  /** The session you were last using, and on which device: other devices offer to continue it. */
  focus: Focus | null;
  /** Stack review (server/review): Inbox alerts, sessions fixing findings, and which branches are layers. */
  review: ReviewState | null;
  /** What this host supports, one version per feature (server/features.ts). `api` stays put for shipped clients. */
  features: Record<string, number>;
  /** Scheduled work (server/jobs): what's next, what's running, what needs your decision. */
  jobs?: JobsState | null;
  /** Sessions cut off mid-flight, to restore (server/interruptions). */
  interruptions?: InterruptionsState | null;
  /** Scratchpads (server/notes): when `cursor` moves, `GET /api/notes?since=` has what changed. */
  notes?: NotesState | null;
  /** Spaces (server/spaces): when `revision` moves, `GET /api/spaces` has a new list. */
  spaces?: SpacesState | null;
  /** Checkouts (server/checkouts): active workspaces, file overlaps, and reclaimable storage. */
  checkouts?: CheckoutsState | null;
  /** Fleet coordination (server/fleet): when `revision` moves, Space tasks / mailbox changed. */
  fleet?: { revision: number } | null;
};

/** `key` is the client's session key (a uid, or "<host>/<uid>" for a peer's session). */
/** What the contexts built on sessions show in the state stream (each a cheap read of its own state). */
export type CoreViews = {
  review: () => ReviewState | null;
  jobs: () => JobsState | null;
  notes: () => NotesState | null;
  spaces: () => SpacesState | null;
  checkouts?: () => CheckoutsState | null;
  fleet?: () => { revision: number } | null;
  /** Which of History's conversations to show this pass: a removed Space's are hidden (server/spaces). */
  historyFilter: (live: Array<{ space?: string | null; createdAt: number }>) => (h: HistoryItem) => boolean;
  /**
   * Which Space a session is in (server/spaces): its own choice (`ah.space`; null: none), else the
   * Space its project (short path) is attached to, else none.
   */
  spaceFor?: (chosen: string | null | undefined, projectPath: string | null) => string | null;
  /** Whether a Space by that name is on this host now. */
  hasSpace?: (name: string) => Promise<boolean>;
  interruptions: () => InterruptionsState | null;
  /** A session's recovery, if any (server/recovery). */
  recoveryOf: (s: { uid: string; agent?: string | null; harness?: string; harnessId: string | null }) => RecoveryView | null;
};

/** Narrow port Core uses for checkout ownership, fork worktrees, and resume recreation. */
export type CoreCheckoutPort = {
  acquireForLaunch: (input: AcquireLaunchInput) => Promise<AcquiredCheckout>;
  ensureForResume: (input: ResumeAcquireInput) => Promise<AcquiredResume>;
  transferOwner: (fromUid: string, toUid: string) => Promise<void>;
};

/** Everything Core is handed by the composition root (Core.connect). */
export type CoreConnections = {
  harnesses: Harnesses;
  peers: Peers;
  /** Native push beside Web Push. */
  apns: Apns;
  launchEnv: () => Promise<Record<string, string>>;
  views: CoreViews;
  checkouts?: CoreCheckoutPort;
  /** A transcript ah copied for a fork: usage counts it from here on. */
  copied: (file: string) => void;
  /** A session ended (its window is gone): interruptions and recovery look at why. */
  ended: (r: SessionRecord, lastStatus: string) => void;
  /** Called when relaunch replaces `oldUid` with `newUid` so fleet tasks, mail, and jobs rekey atomically. */
  onRekey?: (oldUid: string, newUid: string) => Promise<void> | void;
  /** Prepares Space context snapshot, AH_SPACE* env vars, and harness launch flags for resume/fork. */
  prepareSpaceContext?: (
    spaceName: string,
    cwd: string,
    opts?: { explicit?: boolean },
  ) => Promise<{
    env: Record<string, string>;
    contextDir: string;
    contextFile: string;
    pointer: string;
    shouldAddDir: boolean;
    shouldInjectPrompt: boolean;
  } | null>;
  /** Actual listening loopback port (when started on an ephemeral/override port). */
  port?: () => number;
  /** Called when a Chief session starts, resumes, or is promoted to ensure Space event wakes exist. */
  onChiefActive?: (o: { uid: string; space: string | null }) => Promise<void> | void;
  /** Called when a Chief session is demoted so its auto-subscribed wakes are cancelled. */
  onChiefInactive?: (uid: string) => Promise<void> | void;
};

export type Focus = { key: string; device: string; client: string; at: number };

/** `starting`: queued only because the agent just launched; it goes in once its UI is up. */
/**
 * `held`: queued only because a screen is in front of the agent's prompt (its trust
 * question, a sign-in, setup) or a picker or question dialog is up; it goes in once that's
 * answered.
 * `trust` is the same for the trust question, for clients that only know that one.
 */
export type SendResult = { outcome: 'delivered' | 'queued'; windowId: string; resumed: boolean; queued: number; queueId?: string; starting?: boolean; trust?: boolean; held?: GateKind | 'picker' };

/** What a send now says when a screen is in front of the prompt. */
const GATE_FIRST: Record<GateKind, string> = {
  trust: 'answer the folder-trust prompt first',
  signin: 'sign in first',
  setup: 'answer the screen in front of its prompt first',
};

/** The picker row a message names by its key ("2", "y"); a cursor list's rows by their number. */
export function pickerRow(options: ScreenOption[] | undefined, text: string): ScreenOption | undefined {
  const typed = text.trim().toLowerCase();
  if (!options?.length || !/^[0-9a-z]$/.test(typed)) return undefined;
  return options.find((o, i) => o.key === typed || (o.key.startsWith('nav:') && String(i + 1) === typed));
}

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

/**
 * Has the window's visible screen held still for `quietMs` (within `ms`)? A
 * working agent's spinner and clock keep it moving; `quietMs` outlasts a
 * once-a-second clock, for agents whose spinner holds still (reduced motion).
 */
async function screenSettles(target: string, quietMs: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  let last: string | null = null;
  let since = Date.now();
  while (Date.now() < until) {
    const text = await t.tmux('capture-pane', '-p', '-t', target).catch(() => null);
    if (text === null) return false;
    if (text !== last) [last, since] = [text, Date.now()];
    else if (Date.now() - since >= quietMs) return true;
    await sleep(100);
  }
  return false;
}

/** A transcript written within this long is one the agent may be mid-turn in. */
const WRITING_MS = 2000;
/** How long a Stop waits for a send in progress to finish typing before it goes in anyway. */
const STOP_WAIT_MS = 1000;


export class CoreError extends DomainError {}

const STATE_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah');
const HIDDEN_FILE = join(STATE_DIR, 'hidden.json');
const AH_BIN_PATH = fileURLToPath(new URL('../bin/ah.js', import.meta.url));

const TICK_MS = 1500;
const now = () => Math.floor(Date.now() / 1000);

export class Core {
  readonly registry: Registry;
  /** Durable prompt queue (F22): state and flush policy live in server/queue.ts. */
  private queues: QueueManager;
  readonly push = new Push();
  readonly viewers: Map<string, string[]>;
  private state: State | null = null;
  /** Which prompt each session was just answered on: one answer per prompt (answers.ts). */
  private answers = new AnswerGuard();
  /** Subscribers get the whole state once, then what each pass changed (stateStream.ts). */
  private stream = new StateStream();
  private tmuxPath = process.env.PATH ?? '';
  private ticking: Promise<State> | null = null;
  /** The pass queued behind the one in flight, for callers that changed something during it. */
  private again: Promise<State> | null = null;
  /** Windows launch() is still setting up: see buildWindows. */
  private launching = new Set<string>();
  private stopped = false;
  private hidden = new Set<string>();
  private prompts: Array<{ text: string; at: number }> = [];
  private promptStore: PromptStore;
  private config: Config;
  private resuming = new Map<string, Promise<{ uid: string; windowId: string; resumed: boolean }>>();
  private inputs = new Map<string, Promise<unknown>>();
  private sentAt = new Map<string, number>();
  /** Sessions whose trust prompt ah is answering right now. */
  private trusting = new Set<string>();
  private snapshots: TurnSnapshots;
  private lastPrune = 0;
  private peers: Peers | null = null;
  /** Each agent CLI's current choices, and the host's hidden and added agents. */
  private harnesses: Harnesses | null = null;
  /** The presets as written (config or built in), before each CLI's current version adjusts them. */
  private basePresets: Preset[];
  /** Variables each new session window starts with (Settings → Environment). */
  private launchEnv: () => Promise<Record<string, string>> = async () => ({});
  private views: CoreViews = { review: () => null, jobs: () => null, notes: () => null, spaces: () => null, checkouts: () => null, historyFilter: () => () => true, interruptions: () => null, recoveryOf: () => null };
  private checkoutPort: CoreCheckoutPort | null = null;
  /** A transcript ah just made as a copy (a fork): usage counts only what's written to it from now. */
  private copied: (file: string) => void = () => {};
  private onRekey: ((oldUid: string, newUid: string) => Promise<void> | void) | null = null;
  private prepareSpaceContext: CoreConnections['prepareSpaceContext'] | null = null;
  private portFn: (() => number) | null = null;
  private onChiefActive: CoreConnections['onChiefActive'] | null = null;
  private onChiefInactive: CoreConnections['onChiefInactive'] | null = null;
  private relaunching = new Set<string>();
  private connected = false;

  /**
   * Plugs in what the sessions context reports about, and hands to, the contexts built on
   * it: once, from the composition root, before start(). Every connection is required, so
   * a forgotten one is a type error rather than a silent default. (Until then, and in unit
   * tests that never connect, the state shows none of them.)
   */
  connect(c: CoreConnections) {
    if (this.connected) throw new Error('Core is already connected');
    this.connected = true;
    this.harnesses = c.harnesses;
    this.peers = c.peers;
    this.push.apns = c.apns;
    this.launchEnv = c.launchEnv;
    this.views = c.views;
    this.checkoutPort = c.checkouts ?? null;
    this.copied = c.copied;
    this.onRekey = c.onRekey ?? null;
    this.prepareSpaceContext = c.prepareSpaceContext ?? null;
    this.portFn = c.port ?? null;
    this.onChiefActive = c.onChiefActive ?? null;
    this.onChiefInactive = c.onChiefInactive ?? null;
    this.registry.onEnd = c.ended;
    this.applyHarnesses();
  }

  /** True while `uid` is being hot-swapped via `relaunch()` (prevents premature teardown in `ended`). */
  isRelaunching(uid: string): boolean {
    return this.relaunching.has(uid);
  }

  /** Secret-free launch options that wire the built-in `ah mcp` server into MCP-capable harnesses. */
  mcpLaunchOptions(preset: Preset): { configFile?: string; nodePath?: string; ahBinPath?: string; allowTools?: boolean } | undefined {
    if (!preset.mcp) return undefined;
    const configFile = preset.mcp.configArgs?.length ? ensureMcpConfigFile(STATE_DIR, AH_BIN_PATH, process.execPath) : undefined;
    return {
      ...(configFile ? { configFile } : {}),
      nodePath: process.execPath,
      ahBinPath: AH_BIN_PATH,
      allowTools: true,
    };
  }

  /** Combines Space context pointer with role-scoped playbook (Chief vs worker) for prompt injection. */
  composeLaunchPointer(o: {
    spacePointer?: string | null;
    supervision?: Supervision | null;
    spaceName?: string | null;
    hasMcp?: boolean;
  }): string | undefined {
    const parts: string[] = [];
    if (o.spacePointer?.trim()) parts.push(o.spacePointer.trim());
    const role: McpRole = o.supervision?.role ?? 'default';
    if (role !== 'default') {
      const playbook = renderRolePlaybook({
        role,
        space: o.supervision?.space ?? o.spaceName ?? null,
        managedBy: o.supervision?.managedBy ?? null,
        hasMcp: o.hasMcp,
      });
      if (playbook) parts.push(playbook);
    }
    return parts.length ? parts.join('\n\n') : undefined;
  }

  /**
   * Run after every pass with its state (portable links settling, the scheduler, recovery):
   * each must be cheap or guard its own overlap; a failure in one never stops the pass.
   */
  readonly afterTick = new Set<(state: State) => void | Promise<void>>();

  constructor(config: Config, viewers: Map<string, string[]>, registry = new Registry(), prompts = new PromptStore(), snapshots = new SnapshotStore()) {
    this.registry = registry;
    this.promptStore = prompts;
    this.snapshots = new TurnSnapshots(registry, snapshots, () => this.config, STATE_DIR);
    this.config = config;
    this.basePresets = config.presets;
    this.viewers = viewers;
    this.queues = new QueueManager(this.registry, {
      withInput: (uid, fn) => this.withInput(uid, fn),
      justSent: (uid) => this.justSent(uid),
      markSent: (uid) => void this.sentAt.set(uid, Date.now()),
      captureTurnStart: (uid, text) => this.snapshots.turnStart(uid, text),
      paste: (windowId, text, enter) => t.pasteText(windowId, text, enter),
      applyLaunchChange: (uid, change) => this.applyLaunchChange(uid, change),
      transcriptMark: (w) => this.transcriptMark(w),
      landed: (uid, mark, text) => this.landed(uid, mark, text),
      writing: async (w) => {
        const file = await this.transcriptFile(w.uid, w.harnessId);
        // A SQLite store (Antigravity) writes its write-ahead log first.
        const at = file ? Math.max(...(await Promise.all([file, `${file}-wal`].map((f) => stat(f).then((s) => s.mtimeMs, () => 0))))) : 0;
        return Date.now() - at < WRITING_MS;
      },
      inputBox: (windowId) => t.inputBox(windowId),
      still: (windowId) => screenSettles(windowId, 1200, 3000),
      clearInput: (windowId) => t.clearInput(windowId, 1000),
      press: (windowId) => t.sendKeys(windowId, 'Enter'),
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
      // The schedule joins a pass in flight rather than queueing another behind it.
      (this.ticking ?? this.tick()).catch((err) => console.error('tick failed:', err)).finally(() => setTimeout(loop, TICK_MS));
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

  /** `fn(full, patch)`: the whole state once at subscribe (patch null), then each change as a patch of changed fields. */
  /**
   * `patch` has every top-level field that changed; `slim` is the same with `windows` as a
   * delta (the windows that changed, and every window's uid in order), for streams that ask
   * for it (?delta=1): one working session no longer resends them all every tick.
   */
  subscribe(fn: (json: string, patch: string | null, slim: string | null) => void): () => void {
    return this.stream.subscribe(fn);
  }

  /**
   * One pass: tmux → windows → registry → history → queue delivery → push to subscribers.
   * Asked mid-pass (a window was just created, a key just sent), the pass in flight read
   * tmux before the change: the caller gets the next one, queued right after it and shared
   * by everyone who asks meanwhile, instead of a state up to a whole tick stale.
   */
  tick(): Promise<State> {
    if (this.ticking) {
      return (this.again ??= this.ticking
        .catch(() => {})
        .then(() => {
          this.again = null;
          return this.tick();
        }));
    }
    this.ticking = (async () => {
      const windows = await buildWindows(this.config, this.viewers, this.registry, this.launching);
      // A just-started agent's transcript appears within seconds; look for it sooner
      // than the usual rescan so its title and GUI view don't lag behind.
      const fresh = windows.some((w) => w.agent && !w.harnessId && Date.now() / 1000 - w.createdAt < 120);
      const transcripts = await discover(fresh ? 2000 : 15_000);
      adoptTranscripts(windows, transcripts, this.registry);
      // The last thing said in each session (lists show it as a chat shows its last message):
      // read in the background when a transcript grows, picked up by the next pass.
      const targets: ReplyTarget[] = [];
      for (const w of windows) {
        const adapter = w.agent ? this.config.presets.find((p) => p.id === w.agent)?.feed : undefined;
        const file = adapter && w.harnessId ? transcripts.find((t) => t.harness === adapter && t.harnessId === w.harnessId)?.file : undefined;
        if (adapter && file) targets.push({ uid: w.uid, file, adapter });
        w.reply = this.replies.peek(w.uid);
      }
      void this.replies.refresh(targets).catch(() => false);
      // The same for what each one's agent spawned: read in the background, carried by the next pass.
      const roots: SubagentRoot[] = [];
      for (const w of windows) {
        const harness = subagentHarness(w.agent ? this.config.presets.find((p) => p.id === w.agent)?.feed : undefined);
        if (!harness) continue;
        w.subagents = this.subagents.peek(w.uid) ?? { total: 0, active: 0, completed: 0, failed: 0, rev: '0' };
        if (!w.harnessId) continue;
        // Claude's children are found beside its transcript; Codex's by discovery, which needs none.
        const file = transcripts.find((t) => t.harness === harness && t.harnessId === w.harnessId && !t.spawned)?.file ?? (harness === 'claude' ? await claudeTranscriptOf(w.harnessId) : '');
        if (file !== null) roots.push({ harness, harnessId: w.harnessId, file, title: w.title, uid: w.uid, live: { live: true, since: w.createdAt }, busy: w.status === 'busy' });
      }
      void this.subagents.refresh(roots).catch(() => {});
      // Where each checkout stands in git and on GitHub: read in the background, carried by the next pass.
      if (this.config.sourceControl) {
        const scm: ScmTarget[] = [];
        for (const w of windows) {
          const repo = repoInfo(expandHome(w.cwd));
          const target = repo ? { uid: w.uid, root: repo.root, main: repo.main, branch: w.branch } : null;
          w.scm = target ? this.scm.peek(target) : null;
          if (target) scm.push(target);
        }
        void this.scm.refresh(scm).catch(() => {});
      } else for (const w of windows) w.scm = null;
      // A submit can precede the agent's next hook/output. Protect that interval
      // so a second device or queued prompt cannot submit another turn into it.
      for (const w of windows) {
        if (w.agent && this.justSent(w.uid) && (w.status === 'idle' || w.status === 'attention')) w.status = 'busy';
        w.unsent = this.queues.unsent(w.uid).length;
      }
      const alive = new Set(windows.map((w) => w.uid));
      for (const uid of this.sentAt.keys()) if (!alive.has(uid)) this.sentAt.delete(uid);
      // Turn boundaries for snapshots (F39). The send path captures too (it knows the
      // prompt, and is the fallback for agents without hooks); one capture per turn.
      this.snapshots.observe(windows);
      if (now() - this.lastPrune > 3600) {
        this.lastPrune = now();
        void this.snapshots.prune().catch((err) => console.error('snapshot prune failed:', err));
      }
      this.answers.observe(windows);
      this.acceptTrust(windows);
      await this.queues.confirmDeliveries(windows);
      await this.queues.deliverDue(windows);
      // One that just stopped working: its answer read now rather than on the next pass, so its
      // "finished" alert and its Live Activity's last line are that answer, not what came before.
      const stopped = targets.filter((t) => this.busyBefore.has(t.uid) && windows.find((w) => w.uid === t.uid)?.status !== 'busy');
      if (stopped.length) {
        await this.replies.readNow(stopped).catch(() => {});
        for (const w of windows) if (stopped.some((t) => t.uid === w.uid)) w.reply = this.replies.peek(w.uid);
      }
      this.busyBefore = new Set(windows.filter((w) => w.status === 'busy').map((w) => w.uid));
      this.push.observe(windows, (id) => this.config.presets.find((p) => p.id === id)?.name ?? id);
      for (const w of windows) if (w.agent) w.recovery = this.views.recoveryOf(w);
      for (const w of windows) {
        const space = this.placeSpace(chosenSpace(this.registry.get(w.uid)?.meta), w.projectPath);
        if (space) w.space = space;
        else delete w.space;
      }
      // Where a conversation is, from its choice and folder: asked again for every ended one below.
      const placed = new Map<string, string | null>();
      const placeDir = (chosen: string | null | undefined, cwd: string) => {
        const k = `${chosen === undefined ? '\u0001' : (chosen ?? '')}\u0000${cwd}`;
        if (!placed.has(k)) placed.set(k, this.placeSpace(chosen, projectOf(expandHome(cwd)).projectPath));
        return placed.get(k)!;
      };
      this.claimForChiefs(windows, placeDir);
      const inSpace = this.views.historyFilter(windows);
      const history = await buildHistory(this.registry, windows, (h) => !this.hidden.has(h.ref) && inSpace(h), 150, placeDir);
      for (const h of history) if (h.kind === 'ended') h.recovery = this.views.recoveryOf({ uid: h.ref, harness: h.harness, harnessId: h.harnessId });
      const state: State = {
        api: API_VERSION,
        hostname: hostName(),
        hosts: [
          { name: hostName(), self: true, online: true },
          ...(this.peers?.list() ?? []).map((p) => ({ name: p.name, self: false, online: p.online })),
        ],
        home: homedir(),
        defaultSession: this.config.defaultSession,
        // Every tmux session has a window, and list-windows -a goes session by session in
        // list-sessions' order: no second tmux call per tick for the same names.
        sessions: [...new Set(windows.map((w) => w.session))],
        windows,
        history,
        presets: await Promise.all(
          this.config.presets.map(async (p) => ({ ...(await withCatalog(p)), available: isExecutableOnPath(p.command, this.tmuxPath), ...(this.harnesses?.hidden(p.id) ? { hidden: true } : {}) })),
        ),
        omarchy: omarchyStamp(),
        focus: this.focus,
        review: this.views.review(),
        features: features(),
        jobs: this.views.jobs(),
        interruptions: this.views.interruptions(),
        notes: this.views.notes(),
        spaces: this.views.spaces(),
        checkouts: this.views.checkouts?.() ?? null,
        fleet: this.views.fleet?.() ?? null,
      };
      this.state = state;
      this.stream.publish(state);
      for (const fn of this.afterTick) {
        try {
          void Promise.resolve(fn(state)).catch((err) => console.error('after-tick hook failed:', err));
        } catch (err) {
          console.error('after-tick hook failed:', err);
        }
      }
      return state;
    })().finally(() => (this.ticking = null));
    return this.ticking;
  }

  /** The presets as each CLI's installed version describes them, then the agents added on this host. */
  applyHarnesses() {
    const h = this.harnesses;
    if (!h) return;
    this.config.presets = [...this.basePresets.map((p) => adjust(p, h.probe(p.id, p.command))), ...h.custom().map(Harnesses.preset)];
  }

  /** Settings → Agents: every agent this host knows, built in or added, with what its CLI said last. */
  harnessList() {
    const agents = this.config.presets
      .filter((p) => p.command.trim())
      .map((p) => {
        const probe = this.harnesses?.probe(p.id, p.command);
        return {
          id: p.id,
          name: p.name,
          command: p.command,
          custom: !!this.harnesses?.custom().some((c) => c.id === p.id),
          installed: isExecutableOnPath(p.command, this.tmuxPath),
          hidden: !!this.harnesses?.hidden(p.id),
          version: probe?.version ?? null,
          checkedAt: probe?.checkedAt ?? null,
          changes: probe?.changes ?? [],
        };
      });
    return { agents, suggestions: suggestions(this.config.presets, (c) => isExecutableOnPath(c, this.tmuxPath)) };
  }

  /** Asks each installed agent CLI its version, reading a new one's --help (server/harnesses.ts). */
  async checkHarnesses(force = false) {
    const h = this.harnesses;
    if (!h) return;
    await this.refreshTmuxPath();
    const all = [...this.basePresets, ...h.custom().map(Harnesses.preset)];
    await h.check(all, { ...process.env, PATH: this.tmuxPath }, (p) => isExecutableOnPath(p.command, this.tmuxPath), force);
    this.applyHarnesses();
    await this.tick();
  }

  async refreshTmuxPath() {
    // Agents launch inside tmux shells, so check availability against tmux's PATH.
    try {
      const out = await t.tmux('show-environment', '-g', 'PATH');
      this.tmuxPath = out.trim().replace(/^PATH=/, '') + ':' + (process.env.PATH ?? '');
    } catch {}
  }

  /** The agents this host knows, as each CLI's version describes them. */
  presets(): Preset[] {
    return this.config.presets;
  }

  /** Whether an agent's command is on tmux's PATH (where sessions run). */
  presetAvailable(id: string): boolean {
    const p = this.config.presets.find((x) => x.id === id);
    return !!p && isExecutableOnPath(p.command, this.tmuxPath);
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
  async feedSource(ref: string, maxAgeMs = 15_000): Promise<{ adapter: string; harness: string; file: string | null; from?: number } | 'no-adapter' | null> {
    const state = await this.current();
    const live = state.windows.find((w) => w.uid === ref);
    const rec = this.registry.get(ref);
    let harness: string | null = live?.agent ?? rec?.harness ?? null;
    let harnessId: string | null = live ? live.harnessId : (rec?.harnessId ?? null);
    if (!live && !rec) {
      // A subagent's own transcript (server/subagents), found under the conversation that spawned it.
      const child = await this.subagents.source(ref);
      if (child) return { adapter: child.adapter, harness: child.harness, file: child.file, ...(child.from ? { from: child.from } : {}) };
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
    /** Resumed by an agent that can't resume: it starts a conversation of its own (Core.resume). */
    newConversation?: boolean;
    pendingResume?: boolean;
    meta?: Record<string, unknown>;
    /** Extra per-session environment variables (e.g., Checkout ports/temp dir), merged over Settings → Environment. */
    env?: Record<string, string>;
    /** Runs once the window exists and is registered, just before the command is typed. */
    beforeCommand?: () => Promise<void>;
  }) {
    if (o.session.startsWith(t.TERMINAL_PREFIX)) throw new CoreError(400, 'reserved terminal session name');
    const uid = o.uid ?? this.registry.freshId();
    let meta = o.meta;
    // A new agent conversation has no id yet: snapshot the transcript ids that
    // already exist so adoption binds by novelty (session identity), never by
    // recency. Taken before the agent starts, so its own transcript is novel.
    // Ids the caller already knows aren't this conversation (one it let go of) count too:
    // their transcript may not be written, or seen, yet.
    if (!o.harnessId && o.preset.feed) {
      const given = meta?.['ah.knownTranscripts'];
      const known = Array.isArray(given) ? given.filter((x): x is string => typeof x === 'string') : [];
      try {
        known.push(...(await discover()).filter((x) => x.harness === o.preset.id).map((x) => x.harnessId));
      } catch {}
      meta = { ...meta, 'ah.knownTranscripts': [...new Set(known)] };
    }
    // What the window starts with, and its fingerprint so Settings can tell
    // which running sessions predate a change. A store failure launches
    // without it rather than not at all.
    const baseEnv = await this.launchEnv().catch((err) => {
      console.error('session environment unavailable:', err);
      return {};
    });
    const sessionToken =
      typeof meta?.['ah.sessionToken'] === 'string' && meta['ah.sessionToken']
        ? (meta['ah.sessionToken'] as string)
        : randomBytes(24).toString('base64url');
    meta = { ...meta, 'ah.env': fingerprint(baseEnv), 'ah.sessionToken': sessionToken };
    const explicitSpace = chosenSpace(meta) ?? undefined;
    let sup = supervisionOf(meta);
    // Started in a Space with a Chief: the Chief's from the start, so it knows whom it reports to.
    if (o.preset.id !== 'shell' && sup?.role !== 'chief' && !sup?.managedBy) {
      const chosen = chosenSpace(meta);
      const chief = this.chiefOwning(chosen !== undefined ? chosen : this.spaceOfDir(o.cwd));
      if (chief && chief !== uid) {
        sup = claimedBy(sup, chief);
        meta = { ...meta, 'ah.supervision': sup };
      }
    }
    const listenPort = this.portFn?.() ?? this.config.port;
    const env = {
      ...baseEnv,
      ...(o.env ?? {}),
      AH_PORT: String(listenPort),
      AH_SESSION_UID: uid,
      AH_SESSION_TOKEN: sessionToken,
      ...(explicitSpace ? { AH_SPACE: explicitSpace } : {}),
      ...(sup?.role ? { AH_ROLE: sup.role } : {}),
      ...(sup?.managedBy ? { AH_MANAGED_BY: sup.managedBy } : {}),
    };
    const windowId = await t.createWindow({ session: o.session, cwd: o.cwd, name: o.name, env });
    // Until the fresh pass below: every pass that could have listed it before its
    // options landed has finished by then (passes run one at a time, in order).
    this.launching.add(windowId);
    let started: StartUndo | null = null;
    try {
      const ts = String(now());
      await t.setWindowOptions(windowId, {
        '@ah-uid': uid,
        '@ah-agent': o.preset.id,
        '@ah-created': ts,
        '@ah-seen': ts,
        ...(o.harnessId ? { '@ah-harness': o.preset.id, '@ah-harness-id': o.harnessId } : {}),
      });
      this.sentAt.delete(uid);
      started = this.registry.starting(uid, {
        harness: o.preset.id,
        harnessId: o.harnessId,
        newConversation: o.newConversation,
        cwd: o.cwd,
        title: o.name,
        tmux: { session: o.session, windowId },
        pendingResume: o.pendingResume,
        meta,
      });
      await o.beforeCommand?.();
      if (o.command) await t.sendLine(windowId, o.command);
      // Answer with the window already in the state, so the page that asked shows it at once
      // instead of polling for the next scheduled pass.
      await this.tick().catch(() => {});
      return { uid, windowId };
    } catch (err) {
      await t.killWindow(windowId).catch(() => {});
      // Undo exactly what the start changed: a session being resumed keeps its record,
      // its queue and its links (it used to be deleted here, with all of them).
      if (started) this.registry.abandonStart(started);
      else if (!o.uid) this.registry.remove(uid);
      throw err;
    } finally {
      this.launching.delete(windowId);
    }
  }

  /**
   * Brings a session back. `ref` is a registry id or `harness:harnessId` from discovery.
   * Live sessions are returned as-is: callers never need to know which case they hit.
   */
  /**
   * The agents a conversation's agent spawned, nested ones too (server/subagents). `ref` is
   * any session ref (a live uid, an ended record, `harness:id`) or a child's own, which
   * answers its whole tree with `self` naming it.
   */
  async subagentTree(ref: string): Promise<SubagentTree & { self: string | null }> {
    const state = await this.current();
    let harness: SubagentHarness | null;
    let harnessId: string | null;
    let self: string | null = null;
    const up = await this.subagents.rootOf(ref);
    if (up) {
      ({ harness, harnessId } = up);
      self = ref;
    } else {
      const live = state.windows.find((w) => w.uid === ref);
      const rec = live ? undefined : this.registry.get(ref);
      if (live || rec) {
        const agent = live ? live.agent : rec!.harness;
        harness = subagentHarness(agent ? this.config.presets.find((p) => p.id === agent)?.feed : undefined);
        harnessId = live ? live.harnessId : (rec!.harnessId ?? null);
      } else {
        const i = ref.indexOf(':');
        if (i <= 0) throw new CoreError(404, 'session not found', 'session_not_found');
        harness = subagentHarness(ref.slice(0, i));
        harnessId = ref.slice(i + 1);
      }
    }
    if (!harness) throw new CoreError(404, "this session's agent has no subagents ah can read", 'no_subagents');
    const window = harnessId ? state.windows.find((w) => w.harnessId === harnessId && subagentHarness(w.agent ? this.config.presets.find((p) => p.id === w.agent)?.feed : undefined) === harness) : undefined;
    const t = harnessId ? (await discover(3000)).find((x) => x.harness === harness && x.harnessId === harnessId && !x.spawned) : undefined;
    const title = window?.title ?? t?.title ?? harness;
    if (!harnessId || !t) return { root: { ref: harnessId ? `${harness}:${harnessId}` : ref, uid: window?.uid ?? null, title, live: !!window }, nodes: [], self };
    const tree = await this.subagents.tree({ harness, harnessId, file: t.file, title, uid: window?.uid ?? null, live: { live: !!window, since: window?.createdAt ?? 0 } });
    if (self && !tree.nodes.some((n) => n.ref === self)) throw new CoreError(404, 'session not found', 'session_not_found');
    return { ...tree, self };
  }

  async resume(ref: string): Promise<{ uid: string; windowId: string; resumed: boolean }> {
    // A Claude subagent runs inside its parent's process: there is nothing of its own to start.
    if (parseClaudeRef(ref)) throw new CoreError(409, "a subagent can't run on its own: its parent agent runs it", 'subagent_read_only');
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
    // The conversation already runs in another window (relaunched under a new uid, or
    // resumed from another device): that's where it is, not a second agent on it.
    if (rec?.harnessId) {
      // By the window's record, not by the process seen in it: a relaunched window is
      // the conversation's from the moment it's registered, before its agent is up.
      const running = state.windows.find((w) => {
        const r = w.uid !== rec.id ? this.registry.get(w.uid) : undefined;
        return !!r && (r.lifecycle === 'live' || r.lifecycle === 'starting') && r.harness === rec.harness && r.harnessId === rec.harnessId;
      });
      if (running) return { uid: running.uid, windowId: running.id, resumed: false };
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
      if (!found) throw new CoreError(404, 'session not found', 'session_not_found');
      // A spawned thread goes on as a conversation of its own only once its tree has stopped:
      // while the agent that spawned it runs, it may still give it work.
      if (found.spawned) {
        if (found.spawned.kind !== 'spawn') throw new CoreError(409, 'the harness runs this thread itself', 'subagent_read_only');
        if (state.windows.some((w) => w.harnessId === found.spawned!.rootId || w.harnessId === found.spawned!.parentId)) {
          throw new CoreError(409, 'the agent that spawned this subagent is still running', 'subagent_running');
        }
      }
      ({ harness, harnessId, cwd, title } = found);
      title = shortTitle(title);
      meta = { 'ah.source': 'discovered' };
      // Already running somewhere (e.g. resumed from another device a moment ago)?
      const w = state.windows.find((w) => w.agent === harness && w.harnessId === harnessId);
      if (w) return { uid: w.uid, windowId: w.id, resumed: false };
    }

    const preset = await withCatalog(this.preset(harness));
    // An agent that can't open its conversation again starts a new one: ah follows that, not
    // the old id, whose transcript would never show what's sent now (and the chat would stop).
    const newConversation = !!harnessId && !resumesConversation(preset, harnessId);
    // The one it let go of is never its conversation again, written or not when it starts.
    const letGo = newConversation ? harnessId : undefined;
    if (newConversation) harnessId = undefined;
    const targetUid = uid ?? this.registry.freshId();
    const wtMeta = rec?.meta['ah.worktree'] as Worktree | undefined;
    // Recreate a reclaimed worktree at its original path and enforce exclusive writer ownership (CHK-2, CHK-5).
    const acquired = this.checkoutPort
      ? await this.checkoutPort.ensureForResume({ uid: targetUid, preset, cwd, worktreeMeta: wtMeta })
      : null;
    const resolvedCwd = acquired ? acquired.cwd : cwd;
    const dir = (await isDir(resolvedCwd)) ? resolvedCwd : homedir();
    const chosen = chosenSpace(rec?.meta);
    const explicitSpace = chosen ?? undefined;
    const spaceLookup = chosen === undefined ? this.spaceOfDir(dir) : chosen;
    const preparedSpace = spaceLookup && this.prepareSpaceContext
      ? await this.prepareSpaceContext(spaceLookup, dir, { explicit: true }).catch(() => null)
      : null;
    // Exact conversation when we know its id, else "most recent in this directory".
    // Previous launch mode/model are preserved (F42); flags that don't apply to
    // resume are dropped by the builder via `appliesTo`.
    const prevSel = rec ? resumeSelection((rec.meta ?? {}) as Record<string, unknown>) : {};
    const resumeSup = rec ? supervisionOf(rec.meta as Record<string, unknown>) : null;
    const resumePointer = this.composeLaunchPointer({
      spacePointer: preparedSpace?.shouldInjectPrompt ? preparedSpace.pointer : null,
      supervision: resumeSup,
      spaceName: spaceLookup,
      hasMcp: !!preset.mcp,
    });
    const resumeMcp = this.mcpLaunchOptions(preset);
    let command: string;
    let launchMeta: Record<string, unknown> | undefined = meta;
    try {
      const plan = buildLaunch(preset, {
        ...prevSel,
        resume: harnessId ?? true,
        ...(preparedSpace?.shouldAddDir || resumePointer
          ? {
              spaceContext: {
                ...(preparedSpace?.shouldAddDir ? { addDir: preparedSpace.contextDir } : {}),
                ...(resumePointer ? { pointer: resumePointer } : {}),
              },
            }
          : {}),
        ...(resumeMcp ? { mcp: resumeMcp } : {}),
      });
      command = plan.command;
      launchMeta = { ...plan.meta, ...meta };
    } catch {
      command = !preset.command ? '' : harnessId && preset.resumeId ? preset.resumeId.replace('{id}', harnessId) : (preset.resume ?? preset.command);
    }
    try {
      const out = await this.launch({
        preset,
        cwd: dir,
        session,
        name: title || preset.id,
        command,
        uid: targetUid,
        harnessId,
        newConversation,
        pendingResume: true,
        env: { ...(acquired?.env ?? {}), ...(preparedSpace?.env ?? {}) },
        meta: {
          ...launchMeta,
          ...(letGo ? { 'ah.knownTranscripts': [letGo] } : {}),
          ...(resumeSup ? { 'ah.supervision': resumeSup } : {}),
          ...(chosen !== undefined ? { 'ah.space': chosen ?? '' } : {}),
          ...(acquired?.checkoutId ? { 'ah.checkoutId': acquired.checkoutId } : {}),
        },
      });
      if (resumeSup?.role === 'chief') {
        void Promise.resolve(this.onChiefActive?.({ uid: out.uid, space: resumeSup.space ?? spaceLookup ?? null })).catch(() => {});
      }
      return { ...out, resumed: true };
    } catch (err) {
      await acquired?.rollback();
      throw err;
    }
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
    throw new CoreError(404, 'session not found', 'session_not_found');
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
    // The title every screen shows ("Docs link audit"), not the record's window name ("claude").
    const title = live?.title || parent.title;
    return {
      canFork: !reason && !!head?.head,
      reason: reason ?? (head?.head ? null : 'forking needs a git repository with at least one commit: two sessions in one checkout would overwrite each other'),
      harness: parent.harness,
      title,
      suggestedName: `${title} (fork)`,
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
        if (Date.now() > deadline) throw new CoreError(409, 'the session is still working; a fork starts when its current turn ends, so try again shortly', 'busy');
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
    const forkUid = this.registry.freshId();
    const { copied, wt, head, name, checkoutId, checkoutEnv, rollbackCheckout } = await this.withInput(parent.uid, async () => {
      const live = (await this.current()).windows.find((w) => w.uid === parent.uid);
      const found = (await discover()).find((x) => x.harness === parent.harness && x.harnessId === parent.harnessId);
      if (!found) throw new CoreError(422, 'no transcript found for this conversation; it may have been cleared or rotated');

      const cwd = expandHome(parent.cwd);
      const head = await headInfo(cwd).catch(() => null);
      if (!head?.head) throw new CoreError(422, 'forking needs a git repository with at least one commit: two sessions in one checkout would overwrite each other');
      if (live && (live.status === 'busy' || this.justSent(parent.uid))) throw new CoreError(409, 'the parent started another turn; try forking when it finishes');

      const name = (o.name?.trim() || `${live?.title || parent.title} (fork)`).slice(0, 80);
      let wt: Worktree;
      let checkoutId: string | null = null;
      let checkoutEnv: Record<string, string> = {};
      let rollbackCheckout: () => Promise<void> = async () => {};
      try {
        if (this.checkoutPort) {
          const acq = await this.checkoutPort.acquireForLaunch({
            uid: forkUid,
            preset,
            cwd,
            name,
            explicitWorktree: true,
            fromRef: head.head,
          });
          wt = acq.worktree!;
          checkoutId = acq.checkoutId;
          checkoutEnv = acq.env;
          rollbackCheckout = acq.rollback;
        } else {
          wt = await createWorktree(cwd, name, head.head);
          rollbackCheckout = async () => {
            await removeWorktree(wt.path, true).catch(() => {});
          };
        }
      } catch (err) {
        if (err instanceof GitError) throw new CoreError(400, err.message);
        throw err;
      }

      let copied: { harnessId: string; file: string };
      try {
        copied = await copyTranscript(parent.harness, found.file, wt.path);
        this.copied(copied.file);
      } catch (err) {
        await rollbackCheckout();
        if (err instanceof ForkError) throw new CoreError(err.status, err.message);
        throw new CoreError(500, `fork failed while copying the conversation: ${(err as Error).message}`);
      }
      return { copied, wt, head, name, checkoutId, checkoutEnv, rollbackCheckout };
    });

    const parentSup = parent.rec ? supervisionOf(parent.rec.meta as Record<string, unknown>) : null;
    const parentChosen = parent.rec ? chosenSpace(parent.rec.meta) : undefined;
    const forkSpaceLookup = parentChosen === undefined ? this.spaceOfDir(wt.path) : parentChosen;
    const preparedSpace = forkSpaceLookup && this.prepareSpaceContext
      ? await this.prepareSpaceContext(forkSpaceLookup, wt.path, { explicit: true }).catch(() => null)
      : null;
    const inherited = parent.rec ? resumeSelection(parent.rec.meta as Record<string, unknown>) : {};
    const sel = { mode: o.mode ?? inherited.mode, model: o.model ?? inherited.model, effort: o.effort ?? inherited.effort };
    // Transitive supervision on fork: a supervised session's fork inherits its supervision & Space.
    const inheritedSup = parentSup?.managedBy ? { ...parentSup, role: parentSup.role === 'chief' ? 'worker' as const : parentSup.role } : parentSup?.space ? { space: parentSup.space } : null;
    const forkPointer = this.composeLaunchPointer({
      spacePointer: preparedSpace?.shouldInjectPrompt ? preparedSpace.pointer : null,
      supervision: inheritedSup,
      spaceName: forkSpaceLookup,
      hasMcp: !!preset.mcp,
    });
    const forkMcp = this.mcpLaunchOptions(preset);
    let command: string;
    let launchMeta: Record<string, unknown>;
    try {
      const plan = buildLaunch(preset, {
        ...sel,
        resume: copied.harnessId,
        ...(preparedSpace?.shouldAddDir || forkPointer
          ? {
              spaceContext: {
                ...(preparedSpace?.shouldAddDir ? { addDir: preparedSpace.contextDir } : {}),
                ...(forkPointer ? { pointer: forkPointer } : {}),
              },
            }
          : {}),
        ...(forkMcp ? { mcp: forkMcp } : {}),
      });
      command = plan.command;
      launchMeta = { ...plan.meta };
    } catch (err) {
      await removeCopiedTranscript(copied.file);
      await rollbackCheckout();
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
        uid: forkUid,
        harnessId: copied.harnessId,
        pendingResume: true,
        env: { ...(checkoutEnv ?? {}), ...(preparedSpace?.env ?? {}) },
        meta: {
          ...launchMeta,
          'ah.worktree': wt,
          ...(checkoutId ? { 'ah.checkoutId': checkoutId } : {}),
          ...(inheritedSup ? { 'ah.supervision': inheritedSup } : {}),
          ...(parentChosen !== undefined ? { 'ah.space': parentChosen ?? '' } : {}),
          'ah.order': this.nextOrder(),
          'ah.fork': forkMeta,
        },
      });
    } catch (err) {
      await removeCopiedTranscript(copied.file);
      await rollbackCheckout();
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
  async send(ref: string, text: string, enter = true, launchChange?: LaunchChange, o: { id?: string; remember?: boolean; actorUid?: string | null } = {}): Promise<SendResult> {
    if (!text) throw new CoreError(400, 'empty message', 'empty_message');
    const resolvedTarget = uidOfRef(this.registry.all(), ref) ?? ref;
    const controlMode = this.assertControl(o.actorUid, resolvedTarget, 'send');
    if (controlMode === 'upward_communicate') {
      if (!enter) {
        throw new CoreError(403, 'unidirectional control: cannot type raw keystrokes (enter=false) into a supervisor session; use a normal message or `ah mail send`', 'upward_control_denied');
      }
      const liveNow = (await this.current()).windows.find((w) => w.uid === resolvedTarget);
      if (!liveNow) {
        throw new CoreError(403, 'unidirectional control: a child session cannot resume a stopped supervisor; leave a message with `ah mail send`', 'upward_control_denied');
      }
      if (liveNow.status === 'waiting') {
        throw new CoreError(403, 'unidirectional control: cannot send directly while supervisor is waiting on a prompt; leave a message with `ah mail send`', 'upward_control_denied');
      }
    }
    // Asked again for a message it named: answered before anything else happens (no
    // resume, no picker row, not remembered twice) — wherever the conversation is now.
    const again = o.id ? this.namedAgain(ref, o.id) : null;
    if (again) return again;
    const target = await this.resume(ref);
    const state = target.resumed ? await this.tick() : await this.current();
    // A message that is just one of the picker's keys ("2", "y") picks that row, as
    // typing it in the terminal would; anything else waits for the picker to go.
    const shown = state.windows.find((w) => w.id === target.windowId);
    const row = enter && !target.resumed && shown?.agent && shown.status === 'waiting' ? pickerRow(shown.ask?.options, text) : undefined;
    if (row) {
      if (controlMode === 'upward_communicate') {
        throw new CoreError(403, 'unidirectional control: a child session cannot answer its supervisor\'s prompt', 'upward_control_denied');
      }
      await this.choose(shown!.uid, row.key, o.actorUid);
      if (o.id) this.queues.noteDelivered(shown!.uid, o.id);
      return { outcome: 'delivered', windowId: target.windowId, resumed: false, queued: 0 };
    }
    if (o.remember !== false) this.remember(text);
    // A session's link in a message to an agent: which session it is, and how to read it.
    const toAgent = shown ? !!shown.agent : (this.registry.get(target.uid)?.harness ?? 'shell') !== 'shell';
    if (toAgent) text = linkHints(text, (uid) => state.windows.find((x) => x.uid === uid)?.title ?? this.registry.get(uid)?.title ?? null, this.ahCommand);
    return this.withInput<SendResult>(target.uid, async () => {
      const w = state.windows.find((w) => w.id === target.windowId);
      const queued = this.queues.items(target.uid);
      // A caller that names its message (a continuation, a scheduled run) can ask again
      // after a crash or a retry: already waiting in the queue, it isn't queued twice.
      if (o.id && queued.some((q) => q.id === o.id)) {
        return { outcome: 'queued', windowId: target.windowId, resumed: target.resumed, queued: queued.length, queueId: o.id };
      }
      // …and already typed (directly, or from the queue), it isn't typed twice.
      if (o.id && this.queues.wasDelivered(target.uid, o.id)) {
        return { outcome: 'delivered', windowId: target.windowId, resumed: false, queued: queued.length };
      }
      // A waiting agent is blocked on your input: what you send now is the
      // answer to its question or approval prompt, so it is typed immediately
      // instead of queued behind the turn that asked. (The ticker never flushes
      // the queue into a waiting session, so queueing here would strand it.)
      // Shells take input immediately (a dev server is always "busy"); agents get queued while working.
      // A just-launched agent (a new session's first prompt) waits for the queue until
      // its UI is up: before that, Enter doesn't submit. Its process may not exist yet
      // (the window still looks like a shell), so the launch record says what it is.
      const settled = !!w?.agent && (w.status !== 'busy' || this.sentAt.has(w.uid));
      const fresh = !!w && starting(w) && !settled && (!!w.agent || (this.registry.get(w.uid)?.harness ?? 'shell') !== 'shell');
      // A screen in front of the prompt (trust, sign-in, setup), a picker or a question
      // dialog is not a question this text answers: the TUI drops the paste and takes the
      // Enter as its highlighted row, so the text would vanish and the row be chosen for
      // you. It waits in the queue and goes in once that's answered and the agent is at
      // its prompt. (The dialog is answered with its own form: POST …/questions.)
      const held: SendResult['held'] =
        w?.agent && w.status === 'waiting' ? (w.ask?.gate?.kind ?? (w.ask?.options?.length || w.ask?.kind === 'choice' ? 'picker' : undefined)) : undefined;
      // One answer per question, from any device (answers.ts): a second answer to the one
      // just answered would land as a new turn nobody asked for, so it's refused, as a
      // second approve is. Text typed without Enter answers nothing and claims nothing.
      const free = !target.resumed && !!w && !fresh;
      const asking = free && !!w.agent && w.status === 'waiting' && !held;
      if (controlMode === 'upward_communicate' && w?.status === 'waiting') {
        throw new CoreError(403, 'unidirectional control: cannot send directly while supervisor is waiting on a prompt; leave a message with `ah mail send`', 'upward_control_denied');
      }
      if (o.actorUid && w?.status === 'waiting') {
        if (o.actorUid === target.uid) {
          throw new CoreError(403, 'a session cannot answer its own waiting prompt', 'self_control_denied');
        }
        const blocked = checkApprovalGuardrail(w.ask);
        if (blocked) throw new CoreError(403, blocked.reason, 'guardrail_blocked');
      }
      if (asking && enter && !this.answers.claim(w.uid, w.askId ?? null, Date.now())) throw new CoreError(409, 'that question was just answered', 'already_answered');
      const answering = asking;
      // One not yet seen in the conversation goes first: this one waits its turn behind it.
      const ready = free && (answering || queued.length === 0) && (answering || !w.agent || (!this.justSent(w.uid) && !this.queues.watching(w.uid) && (w.status === 'idle' || w.status === 'attention')));
      if (ready) {
        // Watched like a queued follow-up until the conversation shows it. An answer isn't:
        // it reaches the conversation as the agent's dialog records it, not as a message.
        const sent: QueueItem = { id: o.id ?? randomUUID().slice(0, 8), ...(o.id ? { named: true } : {}), text, enter, at: now() };
        const mark = w.agent && !answering ? await this.queues.markFor(w, sent) : null;
        if (w.agent) {
          this.sentAt.set(w.uid, Date.now());
          // Snapshot before the prompt lands, so the turn starts from a known state (F39).
          if (enter) await this.snapshots.turnStart(target.uid, text);
        }
        try {
          await t.pasteText(target.windowId, text, enter);
        } catch (err) {
          const typedNothing = err instanceof t.PasteError && !err.typed;
          // Some of it landed: it counts as typed (never twice), and still fails here.
          if (o.id && !typedNothing) this.queues.noteDelivered(target.uid, o.id);
          // Nothing reached it: the question is still unanswered.
          if (answering && enter && typedNothing) this.answers.release(w.uid, w.askId ?? null);
          throw err;
        }
        if (mark) this.queues.delivered(target.uid, sent, mark);
        else if (o.id) this.queues.noteDelivered(target.uid, o.id);
        if (launchChange) this.applyLaunchChange(target.uid, launchChange);
        return { outcome: 'delivered', windowId: target.windowId, resumed: false, queued: 0 };
      }
      const item: QueueItem = {
        id: o.id ?? randomUUID().slice(0, 8),
        ...(o.id ? { named: true } : {}),
        text,
        enter,
        at: now(),
        ...(launchChange ? { launchChange } : {}),
      };
      const queuedCount = this.queues.enqueue(target.uid, item);
      return { outcome: 'queued', windowId: target.windowId, resumed: target.resumed, queued: queuedCount, queueId: item.id, ...(fresh ? { starting: true } : {}), ...(held ? { held } : {}), ...(held === 'trust' ? { trust: true } : {}) };
    });
  }

  /**
   * A named message asked for again: already typed into the conversation (under any of
   * its records — a relaunch moves it to a new uid), or still queued where it runs now.
   * A queued one on a stopped record is left to the send, whose resume delivers it.
   */
  private namedAgain(ref: string, id: string): SendResult | null {
    const known = uidOfRef(this.registry.all(), ref);
    const rec = known ? this.registry.get(known) : undefined;
    if (!rec) return null;
    const records = rec.harnessId ? this.registry.all().filter((r) => r.harness === rec.harness && r.harnessId === rec.harnessId) : [rec];
    const answer = (r: SessionRecord, outcome: SendResult['outcome']): SendResult => {
      const queued = this.queues.items(r.id);
      return { outcome, windowId: r.tmux?.windowId ?? '', resumed: false, queued: queued.length, ...(outcome === 'queued' ? { queueId: id } : {}) };
    };
    const typed = records.find((r) => this.queues.wasDelivered(r.id, id));
    if (typed) return answer(typed, 'delivered');
    const waiting = records.find((r) => (r.lifecycle === 'live' || r.lifecycle === 'starting') && this.queues.items(r.id).some((q) => q.id === id));
    return waiting ? answer(waiting, 'queued') : null;
  }

  private applyLaunchChange(uid: string, change: LaunchChange) {
    if (change.model !== undefined) this.registry.setMeta(uid, 'ah.launch.model', change.model === 'default' ? undefined : change.model);
    if (change.effort !== undefined) this.registry.setMeta(uid, 'ah.launch.effort', change.effort === 'default' ? undefined : change.effort);
  }

  /**
   * Where a live window's line transcript ends now: to look for a delivery after it.
   * From the window itself, not feedSource (which reads the state a tick is building).
   */
  /**
   * Where the window's conversation ends before ah types into it, read the way its chat
   * view reads it (any harness with a feed); null for one ah can't read (a shell, a
   * custom agent), which nothing then confirms.
   */
  private async transcriptMark(w: WindowView): Promise<ConversationMark | null> {
    const adapter = this.feedOf(w.uid, w.agent);
    if (!confirms(adapter)) return null;
    return markConversation(adapter, await this.transcriptFile(w.uid, w.harnessId));
  }

  /** Whether the session's conversation has `text` from the user after `mark`; yes when it can't be told. */
  private async landed(uid: string, mark: ConversationMark, text: string): Promise<boolean> {
    const file = mark.file ?? (await this.transcriptFile(uid));
    // Never found (a conversation ah couldn't tie to the session): nobody can tell, so
    // it's never typed twice.
    return file ? conversationHas(mark, file, text) : true;
  }

  private feedOf(uid: string, agent: string | null): string | undefined {
    const preset = agent ?? this.registry.get(uid)?.harness;
    return preset ? this.config.presets.find((p) => p.id === preset)?.feed : undefined;
  }

  /** The session's conversation file, once its agent has written one and ah has tied it to the session. */
  private async transcriptFile(uid: string, harnessId?: string | null): Promise<string | null> {
    const id = harnessId ?? this.registry.get(uid)?.harnessId;
    const adapter = this.feedOf(uid, this.state?.windows.find((w) => w.uid === uid)?.agent ?? null);
    if (!id || !adapter) return null;
    return (await discover(15_000).catch(() => [])).find((t) => t.harness === adapter && t.harnessId === id)?.file ?? null;
  }

  /** Each live session's last message (`WindowView.reply`). */
  private replies = new LastReplies();
  /** Each live session's checkout in source control (`WindowView.scm`). */
  private scm = new SourceControl();
  /** How an agent here runs ah, for the line a session's link gets (server/sessionLinks.ts). */
  private ahCommand = ahCommand();
  /** The agents each conversation's agent spawned (server/subagents): rows' `subagents`, child refs' feeds. */
  readonly subagents = new SubagentService({ transcripts: (maxAgeMs) => discover(maxAgeMs) });
  /** Sessions working at the last tick: one that's stopped since has its answer read at once. */
  private busyBefore = new Set<string>();

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

  /** The processes in a live session's pane: its shell and everything under it. Null when it isn't running. */
  async sessionPids(uid: string): Promise<number[] | null> {
    const w = (await this.current()).windows.find((x) => x.uid === uid);
    if (!w) return null;
    const raw = (await t.listWindows()).filter((r) => r.windowId === w.id || r.session === t.TERMINAL_PREFIX + uid);
    if (!raw.length) return null;
    const tree = await procTree();
    return raw.flatMap((r) => descendants(tree, r.panePid, true).map((p) => p.pid));
  }

  /**
   * A copy of the session's queued items, oldest first (state lives in the QueueManager);
   * with `unsent`, after what was typed in and never reached its conversation: removing one
   * lets it go, Send now types it again.
   */
  queue(uid: string, unsent = false): QueueItem[] {
    return [...(unsent ? this.queues.unsent(uid) : []), ...this.queues.items(uid)];
  }

  /** Reorder: one queued item to position `to`. 404 once it was delivered or dropped. */
  moveQueued(uid: string, itemId: string, to: number): QueueItem[] {
    const items = this.queues.move(uid, itemId, to);
    if (!items) throw new CoreError(404, 'that message is no longer queued', 'queue_item_gone');
    return items;
  }

  /** Put an item first in line (server/interruptions: the note goes before your prompts). */
  queueFirst(uid: string, item: QueueItem) {
    this.queues.requeue(uid, item);
  }

  /** Drop one queued item or the whole queue. */
  clearQueue(uid: string, itemId?: string) {
    this.queues.clear(uid, itemId);
  }

  /**
   * One-tap answer to a permission prompt. Re-checks against a fresh tick that the
   * session is *still* waiting, so a stale button never types into a live agent.
   */
  /** Returns the current supervision hierarchy map across all registered sessions. */
  supervisionGraph(): Map<string, Supervision> {
    return supervisionGraph(this.registry.all() as Array<{ id: string; meta?: Record<string, unknown> }>);
  }

  /**
   * A Space's Chief owns every session in its Space, running or ended, that no live session
   * supervises (supervision.ts chiefClaims): written as each one's supervision, so control,
   * wakes and a later resume follow it, and shown on this pass's windows.
   */
  private claimForChiefs(windows: WindowView[], placeDir: (chosen: string | null | undefined, cwd: string) => string | null) {
    const owners = spaceOwners(
      windows.filter((w) => w.supervision?.role === 'chief').map((w) => ({ uid: w.uid, space: w.supervision?.space ?? w.space ?? null, createdAt: w.createdAt })),
    );
    if (!owners.size) return;
    const sessions = [
      ...windows.filter((w) => w.agent).map((w) => ({ uid: w.uid, space: w.space ?? null })),
      ...this.registry
        .all()
        .filter((r) => r.lifecycle === 'ended' && r.harness !== 'shell')
        .map((r) => ({ uid: r.id, space: placeDir(chosenSpace(r.meta), r.cwd) })),
    ];
    const live = (uid: string) => {
      const lifecycle = this.registry.get(uid)?.lifecycle;
      return !!lifecycle && lifecycle !== 'ended';
    };
    const claims = chiefClaims({ owners, sessions, graph: this.supervisionGraph(), live });
    if (!claims.size) return;
    const next = new Map([...claims].map(([uid, chief]) => [uid, claimedBy(supervisionOf(this.registry.get(uid)?.meta), chief)]));
    this.registry.setMetaMany('ah.supervision', next);
    for (const w of windows) {
      const sup = next.get(w.uid);
      if (sup) w.supervision = sup;
    }
  }

  /** The Chief a session starting in `space` belongs to (claimForChiefs), from the last pass's windows. */
  private chiefOwning(space: string | null): string | null {
    if (!space) return null;
    const chiefs = (this.state?.windows ?? []).filter((w) => w.supervision?.role === 'chief');
    return spaceOwners(chiefs.map((w) => ({ uid: w.uid, space: w.supervision?.space ?? w.space ?? null, createdAt: w.createdAt }))).get(space) ?? null;
  }

  /** Which Space a session is in, from its own choice and its project (CoreViews.spaceFor). */
  private placeSpace(chosen: string | null | undefined, projectPath: string | null): string | null {
    return this.views.spaceFor ? this.views.spaceFor(chosen, projectPath) : (chosen ?? null);
  }

  /** The Space a session started in `dir` is in when it isn't put in one: its project's, if attached. */
  spaceOfDir(dir: string): string | null {
    return this.placeSpace(undefined, projectOf(expandHome(dir)).projectPath);
  }

  /** Which Space a session is in (docs/spec/17-spaces.md): the one it was put in, else its project's, else none. */
  spaceOf(ref: string): string | null {
    const uid = uidOfRef(this.registry.all(), ref) ?? ref;
    const rec = this.registry.get(uid);
    const chosen = chosenSpace(rec?.meta);
    if (chosen !== undefined) return chosen;
    const live = this.state?.windows.find((w) => w.uid === uid);
    if (live) return live.space ?? null;
    return rec?.cwd ? this.spaceOfDir(rec.cwd) : null;
  }

  /**
   * Verifies `X-AH-Session-Token` when a session record holds a launch secret.
   * Prevents a session from impersonating another launched session's UID.
   */
  verifyActorToken(actor: string | null, token: string | null): void {
    if (!actor) return;
    const rec = this.registry.get(actor);
    const expected = typeof rec?.meta['ah.sessionToken'] === 'string' ? (rec.meta['ah.sessionToken'] as string) : null;
    if (!expected) return;
    if (!token) throw new CoreError(403, `session ${actor} identity requires X-AH-Session-Token`, 'invalid_session_token');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(token, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new CoreError(403, `invalid session token for ${actor}`, 'invalid_session_token');
    }
  }

  /**
   * Enforces strict unidirectional control (`CoS > session`) and self-control guardrails
   * when `actorUid` is set. Returns `'upward_communicate'` when a child sends upward.
   */
  assertControl(actorUid: string | null | undefined, targetRef: string, action: ControlAction): 'control' | 'upward_communicate' {
    const targetUid = uidOfRef(this.registry.all(), targetRef) ?? targetRef;
    const targetSpace = this.spaceOf(targetUid);
    const verdict = checkSessionControl({
      actorUid,
      targetUid,
      graph: this.supervisionGraph(),
      targetSpace,
      action,
    });
    if (!verdict.ok) throw new CoreError(403, verdict.message, verdict.code);
    return verdict.mode;
  }

  /**
   * Puts a session in a Space (`PUT /api/sessions/:uid/space`): `space` a Space's name; `''` none
   * (out of every Space, its project's too); `null` back to its project's Space, if attached.
   * Answers the Space it's in now.
   */
  async setSessionSpace(uid: string, space: string | null, actorUid?: string | null): Promise<string | null> {
    const rec = this.registry.get(uid);
    if (!rec) throw new CoreError(404, 'session not found', 'session_not_found');
    this.assertControl(actorUid, uid, 'supervision');
    const actorSup = actorUid ? this.supervisionGraph().get(actorUid) : null;
    if (space) {
      const trimmed = space.trim();
      if (!trimmed || trimmed.length > 64 || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
        throw new CoreError(400, 'invalid space name', 'invalid_space_name');
      }
      if (actorSup?.role === 'chief' && actorSup.space && trimmed.toLowerCase() !== actorSup.space.toLowerCase()) {
        throw new CoreError(403, `chief ${actorUid} is scoped to Space "${actorSup.space}" and cannot move sessions into "${trimmed}"`, 'not_managed_by_caller');
      }
      if (this.views.hasSpace && !(await this.views.hasSpace(trimmed))) throw new CoreError(404, `no Space called ${trimmed} on this host`, 'space_not_found');
      this.registry.setMeta(uid, 'ah.space', trimmed);
    } else {
      if (actorSup?.role === 'chief' && actorSup.space) {
        throw new CoreError(403, `chief ${actorUid} is scoped to Space "${actorSup.space}" and cannot remove a session from its Space`, 'not_managed_by_caller');
      }
      this.registry.setMeta(uid, 'ah.space', space === '' ? '' : undefined);
    }
    await this.tick().catch(() => {});
    return this.spaceOf(uid);
  }

  /** Updates a session's supervision metadata (role, managedBy, space, muteAlerts, escalateAfterSeconds, tags). */
  setSupervision(uid: string, patch: Record<string, unknown>, actorUid?: string | null): Supervision | null {
    const rec = this.registry.get(uid);
    if (!rec) throw new CoreError(404, 'session not found', 'session_not_found');
    const graph = this.supervisionGraph();
    const check = checkSupervisionMutation({ actorUid, targetUid: uid, patch, graph, targetSpace: this.spaceOf(uid) });
    if (!check.ok) throw new CoreError(check.status, check.message, check.code);
    const current = supervisionOf(rec.meta as Record<string, unknown>);
    const next = mergeSupervision(current, patch, uid, graph);
    this.registry.setMeta(uid, 'ah.supervision', next ?? undefined);
    if (next?.role === 'chief' && (current?.role !== 'chief' || current?.space !== next.space)) {
      void Promise.resolve(this.onChiefActive?.({ uid, space: next.space ?? this.spaceOf(uid) })).catch(() => {});
    } else if (current?.role === 'chief' && next?.role !== 'chief') {
      void Promise.resolve(this.onChiefInactive?.(uid)).catch(() => {});
    }
    this.tick().catch(() => {});
    return next;
  }

  /**
   * One-tap Approve/Deny. `prompt` is the `askId` the caller saw (a notification's, a Live
   * Activity's): when given, it must still be the prompt on screen, so an old alert never
   * approves a newer command nobody read. Checked again inside the input lock.
   */
  async answer(uid: string, answer: 'approve' | 'deny', prompt?: string, actorUid?: string | null) {
    this.assertControl(actorUid, uid, 'answer');
    const check = (w: WindowView | undefined): WindowView => {
      if (!w) throw new CoreError(404, 'session not found', 'session_not_found');
      if (w.status !== 'waiting') throw new CoreError(409, 'it is no longer waiting', 'not_waiting');
      if (!w.answerable || !w.agent) throw new CoreError(400, 'this prompt needs a reply, not approve/deny');
      if (prompt && w.askId !== prompt) throw new CoreError(409, 'it is asking something else now', 'prompt_changed');
      if (actorUid && answer === 'approve') {
        const blocked = checkApprovalGuardrail(w.ask);
        if (blocked) throw new CoreError(403, blocked.reason, 'guardrail_blocked');
      }
      return w;
    };
    const w = check((await this.tick()).windows.find((w) => w.uid === uid));
    const keys = answer === 'approve' ? this.preset(w.agent!).approveKeys : this.preset(w.agent!).denyKeys;
    if (!keys?.length) throw new CoreError(400, `no ${answer} keys configured for ${w.agent}`);
    await this.withInput(uid, async () => {
      // Nothing typed meanwhile (a send, another device's answer) changed what it asks.
      // Read here, never through tick(): a pass in flight may be waiting for this very
      // lock to deliver a queued follow-up, and waiting on that pass would hold both.
      const now = check((await buildWindows(this.config, this.viewers, this.registry, this.launching)).find((x) => x.uid === uid));
      if (now.askId !== w.askId) throw new CoreError(409, 'it is asking something else now', 'prompt_changed');
      await this.answerOnce(uid, w.askId, () => t.sendKeys(w.id, ...keys));
    });
    this.tick().catch(() => {});
  }

  /** Types an answer to the prompt `askId` unless it was just answered (answers.ts). */
  private async answerOnce(uid: string, askId: string | null, type: () => Promise<unknown>): Promise<void> {
    if (!this.answers.claim(uid, askId, Date.now())) throw new CoreError(409, 'that prompt was just answered', 'already_answered');
    try {
      await type();
    } catch (err) {
      this.answers.release(uid, askId);
      throw err;
    }
  }

  /**
   * Picks one row of a numbered picker on screen (a permission prompt's "Yes, and
   * don't ask again"). The key must be one the fresh screen still offers.
   */
  async choose(uid: string, key: string, actorUid?: string | null) {
    this.assertControl(actorUid, uid, 'choose');
    const state = await this.tick();
    const w = state.windows.find((w) => w.uid === uid);
    if (!w) throw new CoreError(404, 'session not found', 'session_not_found');
    if (w.status !== 'waiting') throw new CoreError(409, 'it is no longer waiting', 'not_waiting');
    const opt = w.ask?.options?.find((o) => o.key === key);
    if (!opt) throw new CoreError(409, 'that choice is no longer on screen', 'choice_gone');
    if (actorUid && !/^(no|cancel|deny|decline|reject|quit|exit)\b/i.test(opt.label.trim())) {
      const blocked = checkApprovalGuardrail(w.ask);
      if (blocked) throw new CoreError(403, blocked.reason, 'guardrail_blocked');
    }
    // Read the screen again inside the input lock: the picker must still be there,
    // and a cursor list is moved from where its cursor is now.
    const option = await this.withInput(uid, async () => {
      const lines = (await t.capturePane(w.id, 0).catch(() => '')).split('\n').map((l) => l.trimEnd());
      const picker = parsePicker(lines.filter((l) => l.trim()).slice(-40));
      const found = picker?.options.find((o) => o.key === key);
      if (!picker || !found) throw new CoreError(409, 'that choice is no longer on screen', 'choice_gone');
      const keys = key.startsWith('nav:') ? cursorKeys(picker.cursor ?? 0, Number(key.slice(4))) : [key];
      await this.answerOnce(uid, w.askId, () => t.sendKeys(w.id, ...keys));
      return found;
    });
    // The agent records that it asked, not which row: what you picked stays in its
    // conversation (server/feed/picked.ts).
    const at = Date.now();
    this.feedSource(uid)
      .then((src) => src && src !== 'no-adapter' && src.file && picked.remember(src.file, option.label, at))
      .catch(() => {});
    this.tick().catch(() => {});
    return option;
  }

  /**
   * Answers the screen in front of the agent's prompt with the text it asks for (a
   * code pasted back, an API key), or takes it a step back with Esc where the screen
   * says Esc does that. The text may be a secret: it is never remembered or logged.
   *
   * `callback`: the address a browser on another device ended on after a sign-in that
   * hands back to this host (127.0.0.1, where the agent listens). ah opens it here, as
   * a browser on this host would have, once it matches that sign-in exactly.
   */
  async answerGate(uid: string, o: { text: string } | { back: true } | { callback: string }, actorUid?: string | null): Promise<{ status?: number }> {
    this.assertControl(actorUid, uid, 'gate');
    const state = await this.tick();
    const w = state.windows.find((w) => w.uid === uid);
    if (!w) throw new CoreError(404, 'session not found', 'session_not_found');
    const back = 'back' in o;
    const relay = 'callback' in o;
    if ('text' in o && !o.text.trim()) throw new CoreError(400, 'nothing to type');
    const fits = (g: Gate | undefined) => (back ? !!g?.back : relay ? !!g?.callback : !!g?.input);
    if (w.status !== 'waiting' || !fits(w.ask?.gate)) {
      throw new CoreError(409, back ? 'this screen has no way back' : relay ? 'this screen has no sign-in to finish' : 'this screen takes nothing typed');
    }
    if (actorUid && !back) {
      const blocked = checkApprovalGuardrail(w.ask);
      if (blocked) throw new CoreError(403, blocked.reason, 'guardrail_blocked');
    }
    const preset = this.config.presets.find((p) => p.id === w.agent);
    let status: number | undefined;
    await this.withInput(uid, async () => {
      // Read the screen again inside the lock: it must still be the one that asked.
      const lines = (await t.capturePane(w.id, 0).catch(() => '')).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
      const gate = readGate(lines.slice(-40), compileGates(preset ?? {}))?.gate;
      if (!fits(gate)) throw new CoreError(409, 'the screen has changed; look again', 'prompt_changed');
      if (back) return void (await t.sendKeys(w.id, 'Escape'));
      if ('callback' in o) {
        const url = callbackFor(gate!, o.callback);
        if (!url) throw new CoreError(400, `that isn't the address this sign-in hands back to (${gate!.callback}…, from this sign-in)`);
        try {
          const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
          status = res.status;
          await res.body?.cancel().catch(() => {});
        } catch {
          throw new CoreError(502, 'nothing answered there: the sign-in may have timed out; start it again');
        }
        return;
      }
      // Not the prompt's paste: that one watches the agent's input box, which this isn't.
      await t.pasteText(w.id, (o as { text: string }).text, false);
      await new Promise((r) => setTimeout(r, 150));
      await t.sendKeys(w.id, 'Enter');
    });
    this.tick().catch(() => {});
    return status === undefined ? {} : { status };
  }

  /**
   * Sessions launched with `trust` ("skip startup confirmations") get the agent's
   * folder-trust prompt accepted for them, once: the launch flag is cleared as the
   * keys go in. Runs from the tick, so it never ticks itself.
   */
  private acceptTrust(windows: WindowView[]) {
    for (const w of windows) {
      if (w.status !== 'waiting' || !w.ask?.trust || this.trusting.has(w.uid)) continue;
      if (this.registry.get(w.uid)?.meta['ah.launch.trust'] !== true) continue;
      const accept = w.ask.trust.accept;
      this.trusting.add(w.uid);
      void this.withInput(w.uid, async () => {
        const lines = (await t.capturePane(w.id, 0).catch(() => '')).split('\n').map((l) => l.trimEnd());
        const picker = parsePicker(lines.filter((l) => l.trim()).slice(-40));
        if (!picker?.options.some((o) => o.key === accept)) return;
        this.registry.setMeta(w.uid, 'ah.launch.trust', undefined);
        const keys = accept.startsWith('nav:') ? cursorKeys(picker.cursor ?? 0, Number(accept.slice(4))) : [accept];
        await t.sendKeys(w.id, ...keys);
      })
        .catch((err) => console.error(`trusting the folder for ${w.id} failed:`, err))
        .finally(() => {
          this.trusting.delete(w.uid);
          this.tick().catch(() => {});
        });
    }
  }

  /**
   * Answers the agent's question dialog (Claude's AskUserQuestion) as a whole, from
   * the questions its hook recorded. Each question's keys go in only once the
   * screen shows that question untouched (and the submit only on the review), so
   * input from elsewhere mid-way stops the answer instead of misplacing it.
   */
  async answerQuestions(uid: string, answers: Answer[], actorUid?: string | null) {
    this.assertControl(actorUid, uid, 'questions');
    const w = await this.askingWindow(uid);
    const questions = w.ask?.questions;
    if (!questions) throw new CoreError(409, 'the question on screen has changed; answer it again', 'prompt_changed');
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
  async answerDialogQuestion(uid: string, question: string, answer: Answer, actorUid?: string | null) {
    this.assertControl(actorUid, uid, 'questions');
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

  /**
   * The dialog's "Chat about this": declines its questions and hands the conversation back, to
   * talk the choice over with the agent. `question`, when given, is the question the caller saw;
   * a different one on screen means the request is stale.
   */
  async chatAboutQuestions(uid: string, question?: string, actorUid?: string | null) {
    this.assertControl(actorUid, uid, 'questions');
    const w = await this.askingWindow(uid);
    let steps: Step[] = [];
    await this.typeChecked(w, [
      {
        steps: () => steps,
        ready: (screen: string) => {
          const dialog = parseQuestionDialog(screen.split('\n').map((l) => l.trimEnd()));
          if (!dialog || (question !== undefined && dialog.question !== question)) return false;
          steps = chatSteps(dialog, dialog.cursor);
          return true;
        },
        stale: 'the question on screen has changed; try again',
      },
    ]);
  }

  private async askingWindow(uid: string) {
    const state = await this.tick();
    const w = state.windows.find((w) => w.uid === uid);
    if (!w?.agent) throw new CoreError(404, 'session not found', 'session_not_found');
    if (w.status !== 'waiting' || w.ask?.kind !== 'choice') throw new CoreError(409, 'it is no longer asking', 'not_waiting');
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
          if ('text' in step) await t.sendKeys(w.id, '-l', step.text);
          else await t.sendKeys(w.id, ...step.keys);
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
  async switchLaunch(uid: string, change: { model?: string; effort?: string }, actorUid?: string | null): Promise<SendResult> {
    this.assertControl(actorUid, uid, 'switch');
    if (Number(change.model !== undefined) + Number(change.effort !== undefined) !== 1) throw new CoreError(400, 'choose one setting to switch');
    const state = await this.current();
    const w = state.windows.find((w) => w.uid === uid);
    if (!w?.agent) throw new CoreError(404, 'no agent session', 'no_agent');
    const preset = await withCatalog(this.preset(w.agent));
    let text: string;
    let applied: { model?: string; effort?: string } = change;
    // "default" goes back to the agent's own default, where it has a command for that.
    if (change.model === 'default' && preset.resetModel) text = preset.resetModel;
    else if (change.effort === 'default' && preset.resetEffort) text = preset.resetEffort;
    else if (change.model !== undefined) {
      const model = preset.models?.find((m) => m.id === change.model) ?? customModel(preset, change.model);
      if (!model) throw new CoreError(400, `unknown model: ${change.model}`);
      if (!preset.switchModel) throw new CoreError(400, `${preset.name} can't switch models mid-session; start a new one`);
      const next = modelSwitch(preset.switchModel, model, w.launchEffort ?? preset.defaultEffort, preset.effort?.levels ?? []);
      text = next.text;
      if (next.effort) applied = { ...change, effort: next.effort };
    } else if (change.effort !== undefined) {
      const model = preset.models?.find((m) => m.id === (w.launchModel ?? preset.defaultModel));
      const levels = model?.efforts ?? preset.effort?.levels ?? [];
      if (!levels.includes(change.effort)) throw new CoreError(400, `unsupported effort: ${change.effort}`);
      if (!preset.switchEffort) throw new CoreError(400, `${preset.name} can't change effort mid-session; start a new one`);
      text = preset.switchEffort.replace('{level}', change.effort);
    } else {
      throw new CoreError(400, 'nothing to switch');
    }
    return this.send(uid, text, true, applied);
  }

  /**
   * Changes a live session's permission mode. An agent that cycles modes with a key
   * (Claude: Shift+Tab) gets it pressed until its footer shows the chosen mode, the
   * screen re-read after every press. `switched: false` means this session can't get
   * there live (Claude cycles to bypass only when launched with it, and some agents
   * have no cycle): a relaunch with the mode is the way. Nothing is left changed then.
   */
  async switchMode(uid: string, requestedMode: string, actorUid?: string | null): Promise<{ switched: boolean }> {
    const w = (await this.current()).windows.find((w) => w.uid === uid);
    if (!w?.agent) throw new CoreError(404, 'no agent session', 'no_agent');
    const preset = this.preset(w.agent);
    const resolved = resolvePermissionMode(preset, requestedMode);
    if (!resolved) throw new CoreError(400, `unknown mode: ${requestedMode}`);
    this.assertControl(actorUid, uid, resolved.dangerous ? 'mode_dangerous' : 'mode');
    const mode = resolved.id;
    const cycle = preset.modeCycle;
    if (!cycle) return { switched: false };
    // Cycling can't leave a mode a launch flag set (agy's YOLO): only a relaunch can.
    if (flagOnlyMode(preset, w.launchMode)) return { switched: false };
    // The key means something else in a prompt (Claude: "allow all edits"), and a
    // working agent can open one at any moment: the screen is checked before every press.
    if (w.status === 'waiting') throw new CoreError(409, 'answer the prompt on screen first', 'answer_first');
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const screen = async () => (await t.capturePane(w.id, 0).catch(() => '')).split('\n');
    const read = async () => footerMode(await screen(), cycle.detect, cycle.unnamed, cycle.prompt);
    const switched = await this.withInput(uid, async () => {
      const start = await read();
      if (!start) throw new CoreError(409, `${preset.name} isn't showing its mode right now; try again in a moment`);
      let now = start;
      // Every mode in the cycle once: the ones the footer names, and the one it shows by naming none.
      const modes = Object.keys(cycle.detect).length + (cycle.unnamed ? 1 : 0);
      for (let press = 0; now !== mode && press < modes; press++) {
        const lines = await screen();
        if (parsePicker(lines) || isQuestionDialog(lines)) throw new CoreError(409, `${preset.name} is asking something; answer it, then switch`);
        if (footerMode(lines, cycle.detect, cycle.unnamed, cycle.prompt) !== now) throw new CoreError(409, `${preset.name}'s mode changed under ah; try again`);
        await t.sendKeys(w.id, cycle.key);
        let next = now;
        for (let tries = 0; tries < 12 && next === now; tries++) {
          await sleep(90);
          next = (await read()) ?? now;
        }
        // No visible change: stop rather than press into something else on screen.
        if (next === now) throw new CoreError(409, `${preset.name} didn't change mode`);
        now = next;
        // Round the whole cycle: the mode isn't in it, and we're back where we started.
        if (now === start) break;
      }
      return now === mode;
    });
    if (switched) this.registry.setMeta(uid, 'ah.launch.mode', mode === 'default' ? undefined : mode);
    this.tick().catch(() => {});
    return { switched };
  }

  async openSettings(uid: string, setting: 'model' | 'effort' | 'mode', actorUid?: string | null): Promise<SendResult> {
    this.assertControl(actorUid, uid, 'settings');
    const w = (await this.current()).windows.find((w) => w.uid === uid);
    if (!w?.agent) throw new CoreError(404, 'no agent session', 'no_agent');
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
  async relaunch(uid: string, change: { model?: string; effort?: string; mode?: string }, actorUid?: string | null): Promise<{ uid: string; id: string }> {
    // No change is a plain restart: same flags, a fresh process (new environment).
    if (Number(change.model !== undefined) + Number(change.effort !== undefined) + Number(change.mode !== undefined) > 1) throw new CoreError(400, 'choose one setting to relaunch with');
    const state = await this.current();
    const w = state.windows.find((w) => w.uid === uid);
    if (!w?.agent) throw new CoreError(404, 'no agent session', 'no_agent');
    const checkPreset = this.preset(w.agent);
    const resolvedMode = change.mode !== undefined ? resolvePermissionMode(checkPreset, change.mode) : undefined;
    this.assertControl(actorUid, uid, resolvedMode?.dangerous ? 'mode_dangerous' : 'relaunch');
    if (w.status === 'busy' || w.status === 'waiting' || w.queued > 0 || this.justSent(uid)) {
      throw new CoreError(409, 'relaunch when the session is idle; it is working, waiting or holding queued prompts', 'busy');
    }
    const rec = this.registry.get(uid);
    const harnessId = w.harnessId ?? rec?.harnessId;
    if (!harnessId) throw new CoreError(422, 'this session has no conversation id yet, so there is nothing to resume', 'no_conversation');
    const preset = await withCatalog(this.preset(w.agent));
    let model: string | undefined;
    let effort: string | undefined;
    let mode: string | undefined;
    // "default" relaunches without the flag, so the agent's own default applies.
    if (change.model !== undefined && change.model !== 'default') {
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
    } else if (change.effort !== undefined && change.effort !== 'default') {
      const current = preset.models?.find((m) => m.id === (w.launchModel ?? preset.defaultModel));
      const levels = current?.efforts ?? preset.effort?.levels ?? [];
      if (!preset.effort || !levels.includes(change.effort)) {
        throw new CoreError(400, preset.effort ? `unsupported effort: ${change.effort}` : `${preset.name} has no effort setting`);
      }
      effort = change.effort;
    } else if (change.mode !== undefined) {
      const resolved = resolvePermissionMode(preset, change.mode);
      if (!resolved) throw new CoreError(400, `unknown mode: ${change.mode}`);
      mode = resolved.id;
    }
    const sel: ReturnType<typeof resumeSelection> = rec ? resumeSelection(rec.meta as Record<string, unknown>) : {};
    if (change.model === 'default') delete sel.model;
    if (change.effort === 'default') delete sel.effort;
    if (model !== undefined) sel.model = model;
    if (effort !== undefined) sel.effort = effort;
    if (mode !== undefined) sel.mode = mode;
    const cwd = expandHome(rec?.cwd ?? w.cwd);
    const relaunchDir = (await isDir(cwd)) ? cwd : homedir();
    const relaunchChosen = chosenSpace(rec?.meta);
    const relaunchSpaceLookup = relaunchChosen === undefined ? this.spaceOfDir(relaunchDir) : relaunchChosen;
    const preparedSpace = relaunchSpaceLookup && this.prepareSpaceContext
      ? await this.prepareSpaceContext(relaunchSpaceLookup, relaunchDir, { explicit: true }).catch(() => null)
      : null;
    const relaunchSup = rec ? supervisionOf(rec.meta as Record<string, unknown>) : null;
    const relaunchPointer = this.composeLaunchPointer({
      spacePointer: preparedSpace?.shouldInjectPrompt ? preparedSpace.pointer : null,
      supervision: relaunchSup,
      spaceName: relaunchSpaceLookup,
      hasMcp: !!preset.mcp,
    });
    const relaunchMcp = this.mcpLaunchOptions(preset);
    let plan;
    try {
      plan = buildLaunch(preset, {
        ...sel,
        resume: harnessId,
        ...(preparedSpace?.shouldAddDir || relaunchPointer
          ? {
              spaceContext: {
                ...(preparedSpace?.shouldAddDir ? { addDir: preparedSpace.contextDir } : {}),
                ...(relaunchPointer ? { pointer: relaunchPointer } : {}),
              },
            }
          : {}),
        ...(relaunchMcp ? { mcp: relaunchMcp } : {}),
      });
    } catch (err) {
      throw new CoreError(400, (err as Error).message);
    }
    let session = this.config.defaultSession;
    if (rec?.tmux?.session && (await t.hasSession(rec.tmux.session))) session = rec.tmux.session;
    // The replacement keeps what belongs to the session, not the process: its
    // pin, sidebar place, worktree and fork lineage. Launch choices are new: a choice
    // back to the default writes no key, so the old one would outlive it (YOLO → Auto
    // still read YOLO).
    const {
      'ah.queue': _queue,
      'ah.knownTranscripts': _known,
      'ah.launch.mode': _mode,
      'ah.launch.model': _model,
      'ah.launch.effort': _effort,
      'ah.launch.args': _args,
      ...kept
    } = (rec?.meta ?? {}) as Record<string, unknown>;
    // New window first: if it can't be created, the running session is untouched.
    // The old agent stops only then, before the new one resumes the conversation,
    // so the two never run it at once.
    this.relaunching.add(uid);
    let out: { uid: string; windowId: string };
    try {
      out = await this.launch({
        preset,
        cwd: relaunchDir,
        session,
        name: w.title,
        command: plan.command,
        harnessId,
        pendingResume: true,
        env: preparedSpace?.env,
        meta: { ...kept, ...plan.meta },
        // The old agent must be gone before the new one resumes the conversation:
        // if it won't stop, the relaunch fails (launch removes the new window)
        // rather than run two agents on one conversation. Already gone is fine.
        // In the old session's input lock, so nothing is typed into it as it stops: a
        // message that went in since the check above is the old agent's to answer, and
        // stopping it now would cut that turn off (and its message with it).
        beforeCommand: () =>
          this.withInput(uid, async () => {
            if (this.justSent(uid)) throw new CoreError(409, 'a message just went in, so the relaunch was cancelled; nothing changed', 'message_in_flight');
            try {
              await t.killWindow(w.id);
            } catch {
              // A check that fails can't say it's gone: cancel rather than risk two agents.
              if (await t.windowExists(w.id).catch(() => true)) throw new CoreError(409, "the old window wouldn't stop, so the relaunch was cancelled; nothing changed");
            }
          }),
      });
    } finally {
      this.relaunching.delete(uid);
    }
    await this.snapshots.rekey(uid, out.uid);
    await this.checkoutPort?.transferOwner(uid, out.uid).catch(() => {});
    // Preserve Chief / supervisor continuity across relaunch: rebind all managed workers' managedBy.
    for (const child of this.registry.all()) {
      const sup = supervisionOf(child.meta as Record<string, unknown>);
      if (sup?.managedBy === uid) {
        this.registry.setMeta(child.id, 'ah.supervision', { ...sup, managedBy: out.uid });
      }
    }
    await Promise.resolve(this.onRekey?.(uid, out.uid)).catch(() => {});
    const snap = rec?.meta['ah.snapshots'];
    if (snap !== undefined) this.registry.setMeta(out.uid, 'ah.snapshots', snap);
    this.tick().catch(() => {});
    return { uid: out.uid, id: out.windowId };
  }

  /**
   * Running agent sessions that started with a different environment than
   * `env`, so Settings → Environment can offer to restart them. `restart` is
   * null when a restart can go ahead now, else why not (relaunch's rules).
   */
  async envStale(env: Record<string, string>): Promise<Array<{ uid: string; title: string; agent: string; restart: string | null }>> {
    const want = fingerprint(env);
    // A fresh scan, not the cached state: asked right after a restart, the
    // cache can still hold the window that restart just replaced.
    const state = await this.tick();
    return state.windows
      .filter((w) => w.agent && ((this.registry.get(w.uid)?.meta['ah.env'] as string | undefined) ?? '') !== want)
      .map((w) => ({
        uid: w.uid,
        title: w.title,
        agent: w.agent!,
        restart: !(w.harnessId ?? this.registry.get(w.uid)?.harnessId)
          ? 'no conversation to resume yet'
          : w.status === 'busy' || w.status === 'waiting' || w.queued > 0
            ? 'working; restart when idle'
            : null,
      }));
  }

  /** A live session's agent preset and absolute working directory (composer autocomplete). */
  async sessionPlace(uid: string): Promise<{ preset: Preset | null; cwd: string }> {
    const w = (await this.current()).windows.find((w) => w.uid === uid);
    if (!w) throw new CoreError(404, 'session not found', 'session_not_found');
    return { preset: w.agent ? this.preset(w.agent) : null, cwd: expandHome(this.registry.get(uid)?.cwd ?? w.cwd) };
  }

  /** Stop button: interrupts the agent's current turn (Esc for agents, Ctrl-C for shells). */
  async interrupt(uid: string, actorUid?: string | null) {
    this.assertControl(actorUid, uid, 'interrupt');
    const state = await this.current();
    const w = state.windows.find((w) => w.uid === uid);
    if (!w) throw new CoreError(404, 'session not found', 'session_not_found');
    // In the input lock: a Stop between a send's paste and its Enter would cancel the
    // text that send reports delivered. But a Stop is urgent and the lock can be held for
    // seconds (Send now waiting out a turn, a snapshot of a big tree): it waits at most
    // STOP_WAIT_MS, then goes in anyway. Whatever's typed next waits for the box to be
    // cleared below; the answer doesn't.
    let sent = 0;
    let stopping: Promise<string | null> | null = null;
    // Reads the box and sends the keys, once, from whichever path gets there first.
    const stop = () =>
      (stopping ??= (async () => {
        const box = w.agent ? await t.inputBox(w.id) : null;
        sent = Math.floor(Date.now() / 1000);
        await t.sendKeys(w.id, ...this.interruptKeys(w));
        return box;
      })());
    let begun!: () => void;
    const begin = new Promise<void>((r) => (begun = r));
    const go = () => {
      const p = stop();
      begun();
      return p;
    };
    // The locked turn, taken now: it sends the keys if the lock comes free in time, and
    // either way clears a prompt the Stop handed back before anything else is typed.
    void this.withInput(uid, async () => {
      if ((await go().catch(() => null)) === '') await this.clearHandedBack(w, 1000);
    }).catch(() => {});
    const late = setTimeout(() => void go().catch(() => {}), STOP_WAIT_MS);
    try {
      await begin;
      await stopping;
    } finally {
      clearTimeout(late);
    }
    this.tick().catch(() => {});
    void this.recordStop(w, sent).then(() => this.tick()).catch(() => {});
  }

  /**
   * Forwards a live session's current prompt (or attention request) to the user's
   * devices (Web Push and APNs) with deep-link and one-tap answer metadata when
   * applicable. Used by CLI / orchestrator sessions escalating to the user.
   */
  async forwardPrompt(uid: string, opts: { title?: string; note?: string; actorUid?: string | null } = {}) {
    this.assertControl(opts.actorUid, uid, 'forward');
    const state = await this.tick();
    const w = state.windows.find((x) => x.uid === uid);
    if (!w) throw new CoreError(404, 'session not found', 'session_not_found');
    const sessionTitle = w.title || w.name;
    const title = opts.title?.trim() || `${sessionTitle} needs you`;
    const askText = askLine(w.ask);
    const parts = [w.project, opts.note?.trim(), askText || w.detail || (w.agent ? this.config.presets.find((p) => p.id === w.agent)?.name ?? w.agent : 'Shell')].filter(Boolean);
    const body = parts.join(' · ').slice(0, 300);
    this.push.alert({
      title,
      body,
      tag: w.uid,
      url: `/#${w.uid}`,
      answerable: w.answerable,
      prompt: w.askId,
    });
    return {
      forwarded: true,
      uid: w.uid,
      title,
      body,
      status: w.status,
      ask: w.ask,
      askId: w.askId,
      answerable: w.answerable,
    };
  }

  /**
   * Claude Code stopped before its first word hands the prompt back: it's in the
   * input box again, and what ah typed next was added to it (a queued "1" went in
   * as "…animation1"). It was sent once and shows in the conversation, so what the
   * stop put in a box that was empty before it goes. `ms`: how long to look for it.
   */
  private async clearHandedBack(w: WindowView, ms: number): Promise<void> {
    if (await t.clearInput(w.id, ms)) console.log(`interrupt: cleared the prompt ${w.id}'s stop handed back`);
  }

  /** Sends the interrupt keys; resolves once a hooked turn has visibly stopped. */
  private async sendInterrupt(w: WindowView): Promise<void> {
    const sent = Math.floor(Date.now() / 1000);
    await t.sendKeys(w.id, ...this.interruptKeys(w));
    await this.recordStop(w, sent);
  }

  /**
   * Claude Code ends an interrupted turn without a Stop hook, so its hook state
   * would say "working" until the 30s silence fallback, and a steer would give
   * up waiting first. Its spinner animates while it works: once the screen holds
   * still, ah records the stop the hook never sent, unless a newer hook spoke.
   */
  private async recordStop(w: WindowView, sent: number): Promise<void> {
    if (!w.agent || w.statusSource !== 'hook') return;
    if (!(await screenSettles(w.id, 1200, 5000))) return;
    const [state, at] = (await t.tmux('display-message', '-p', '-t', w.id, '#{@ah-state} #{@ah-state-at}')).trim().split(' ');
    if ((state === 'working' || state === 'waiting') && Number(at) <= sent) {
      await t.tmux('set-option', '-w', '-q', '-t', w.id, '@ah-state', 'idle', ';', 'set-option', '-w', '-q', '-t', w.id, '@ah-state-at', String(Math.floor(Date.now() / 1000)));
    }
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
    if (!w) throw new CoreError(404, 'session is not running', 'not_running');
    return this.withInput<SendResult>(uid, async () => {
      // One the agent never took goes back in line first, then out like any queued one; one
      // its conversation has by now isn't typed again. Inside the lock: a delivery can't take
      // it from the front of the line between the two and leave this call nothing to send.
      if ((await this.queues.sendAgain(uid, itemId)) === 'landed') {
        this.tick().catch(() => {});
        return { outcome: 'delivered', windowId: w.id, resumed: false, queued: this.queues.items(uid).length };
      }
      // The follow-up stays in the queue (on disk) until the moment it's typed: a
      // failure, or a restart, anywhere before that leaves it where it was (at most
      // once, never lost, never twice).
      const next = this.queues.items(uid).find((q) => q.id === itemId);
      if (!next) throw new CoreError(404, 'queued message not found', 'queue_item_gone');
      // The snapshot above can predate a delivery that ran while this call
      // waited for the lock. Decide the interrupt from a fresh read inside
      // the lock: pasting onto that stale input state appends this message
      // to the previous text instead of starting a new turn.
      const live = (await buildWindows(this.config, this.viewers, this.registry, this.launching)).find((x) => x.uid === uid);
      if (!live) throw new CoreError(404, 'session is not running', 'not_running');
      // A screen in front of the prompt has no turn to stop: the interrupt key would
      // cancel it (Claude Code exits on Esc at its trust prompt) and the text would land
      // in it. It stays first.
      const gate = live.agent && live.status === 'waiting' ? live.ask?.gate : undefined;
      if (gate) throw new CoreError(409, `${GATE_FIRST[gate.kind]}; the message goes in right after`, 'gate_first');
      // Still queued? (Another device may have removed it while the window was read.)
      // Checked last before the interrupt: stopping a turn for a message that's gone
      // would cost the agent its turn for nothing.
      if (!this.queues.items(uid).some((q) => q.id === itemId)) throw new CoreError(404, 'queued message not found', 'queue_item_gone');
      const stopping = live.status === 'busy' || live.status === 'waiting' || this.justSent(uid);
      let text = next.text;
      if (stopping && live.agent) {
        // Stop the live turn so the urgent message replaces it, then wait
        // for the stop to land: pasting into the teardown redraw drops the
        // submit and strands this text behind the previous one. Shells
        // clear their own line on Ctrl-C, so they need no settle wait.
        const box = await t.inputBox(live.id);
        const owed = this.queues.watched(uid);
        await this.sendInterrupt(live);
        this.sentAt.delete(uid);
        for (let i = 0; i < 12; i++) {
          const cur = (await buildWindows(this.config, this.viewers, this.registry, this.launching)).find((x) => x.uid === uid);
          if (!cur) throw new CoreError(404, 'session is not running', 'not_running');
          if (cur.status !== 'busy' && cur.status !== 'waiting') break;
          if (i === 11) throw new CoreError(409, 'the agent is working; it did not stop after the interrupt', 'did_not_stop');
          await sleep(500);
        }
        // The stop threw away anything the agent held unsent, a follow-up ah typed
        // into a turn it had started on its own among them: back first in line.
        const requeued = await this.queues.recover(uid);
        // By now the stop has landed and drawn: a prompt it handed back is there to see.
        // Stopped before its first word, Claude Code takes that prompt out of the turn (its
        // transcript keeps the line, the model never sees it): cleared, it was lost, pictures
        // and all. It goes in again with the urgent one, as sent when ah has it.
        const back = box === '' && !requeued ? await t.inputBox(live.id) : null;
        if (box === '') await this.clearHandedBack(live, 0);
        if (back) {
          const again = owed && boxHolds(back, owed.text) ? owed.text : back;
          console.log(`send-now: ${live.id}'s stop handed back a prompt it never answered; it goes in with the urgent message`);
          text = `${again}\n\n${next.text}`;
        }
      } else if (stopping) {
        await t.sendKeys(live.id, ...this.interruptKeys(live));
      }
      if (live.agent) {
        this.sentAt.set(uid, Date.now());
        // The interrupted turn is over; this delivery starts a new one (F39).
        this.snapshots.turnOver(uid);
        if (next.enter) await this.snapshots.turnStart(uid, text);
      }
      const going = text === next.text ? next : { ...next, text };
      const mark = live.agent ? await this.queues.markFor(live, going) : null;
      // Only now out of the queue. Gone already: removed meanwhile (another device).
      if (!this.queues.take(uid, itemId)) throw new CoreError(404, 'queued message not found', 'queue_item_gone');
      try {
        await t.pasteText(live.id, text, next.enter);
        this.queues.delivered(uid, going, mark);
      } catch (err) {
        // Nothing reached the window: the follow-up is still owed, so it
        // goes back first in line. Once any text landed it stays delivered
        // (never twice).
        if (err instanceof t.PasteError && !err.typed) this.queues.requeue(uid, going);
        else if (next.named) this.queues.noteDelivered(uid, next.id);
        throw err;
      }
      if (next.launchChange) this.applyLaunchChange(uid, next.launchChange);
      this.tick().catch(() => {});
      return { outcome: 'delivered', windowId: live.id, resumed: false, queued: this.queues.items(uid).length };
    });
  }

  // ---------- per-turn snapshots (F39): turnSnapshots.ts captures; restoring stops the agent first

  async listSnapshots(uid: string): Promise<{ snapshots: SnapshotInfo[]; enabled: boolean; available: boolean; partial: boolean; branch: string | null }> {
    const rec = this.registry.get(uid);
    if (!rec) throw new CoreError(404, 'session not found', 'session_not_found');
    const snapshots = await this.snapshots.list(uid);
    const available = !!rec.harness && rec.harness !== 'shell' && await mainRepo(expandHome(rec.cwd)).then(() => true).catch(() => false);
    const w = (await this.current()).windows.find((x) => x.uid === uid);
    return {
      snapshots,
      enabled: this.snapshots.settings(uid).enabled,
      available,
      // Turns typed straight into the raw terminal are captured from status
      // transitions only when hooks report them exactly.
      partial: !!w?.agent && w.statusSource !== 'hook',
      branch: w?.branch ?? snapshots[0]?.branch ?? null,
    };
  }

  setSnapshotsEnabled(uid: string, enabled: boolean) {
    const rec = this.registry.get(uid);
    if (!rec) throw new CoreError(404, 'session not found', 'session_not_found');
    this.snapshots.setEnabled(uid, enabled);
    this.tick().catch(() => {});
  }

  /**
   * Rolls the worktree back to a snapshot's pre-turn state. A safety snapshot
   * of the current state is taken first, so the restore is itself undoable.
   * Serialized with sends through the per-session input lock; a working agent
   * must be stopped first, or the caller confirms the interrupt.
   */
  async restoreSnapshot(uid: string, turn: number, opts: { interrupt?: boolean } = {}): Promise<{ safety: SnapshotInfo; restored: SnapshotInfo; notified: boolean }> {
    const rec = this.registry.get(uid);
    if (!rec) throw new CoreError(404, 'session not found', 'session_not_found');
    const target = await this.snapshots.get(uid, turn);
    if (!target) throw new CoreError(404, 'snapshot not found', 'snapshot_not_found');
    // A just-finished turn can still read as busy for a few seconds (the
    // submit-protection window in tick): give a working agent a short grace
    // to finish on its own before calling it busy.
    let w = (await this.tick()).windows.find((x) => x.uid === uid);
    for (let i = 0; i < 12 && w && (w.status === 'busy' || w.status === 'waiting'); i++) {
      await new Promise((r) => setTimeout(r, 500));
      w = (await this.tick()).windows.find((x) => x.uid === uid);
    }
    const out = await this.withInput(uid, async () => {
      w = (await buildWindows(this.config, this.viewers, this.registry, this.launching)).find((x) => x.uid === uid);
      if (w && (w.status === 'busy' || w.status === 'waiting' || this.justSent(uid))) {
        if (!opts.interrupt) throw new CoreError(409, 'the agent is working; stop it first or confirm the interrupt', 'busy');
        await this.sendInterrupt(w);
        this.sentAt.delete(uid);
        for (let i = 0; i < 12; i++) {
          await sleep(500);
          w = (await buildWindows(this.config, this.viewers, this.registry, this.launching)).find((x) => x.uid === uid);
          if (!w || (w.status !== 'busy' && w.status !== 'waiting')) break;
        }
        if (w && (w.status === 'busy' || w.status === 'waiting')) throw new CoreError(409, 'the agent is working; it did not stop after the interrupt', 'did_not_stop');
      }
      this.snapshots.holdTurn(uid);
      const cwd = expandHome(rec.cwd);
      const safety = await this.snapshots.safety(uid, `Before restoring turn ${turn}`);
      if (!safety) throw new CoreError(400, 'could not snapshot the current state; nothing was restored');
      try {
        await restoreSnapshotFiles(cwd, { target: target.commit, current: safety.commit, indexFile: join(STATE_DIR, 'snapshots', uid, 'index-restore') });
      } catch (err) {
        // Undo a partial checkout using the safety snapshot before reporting failure,
        // and say which state the files are in: back as they were, or half-restored.
        const why = (err as Error).message;
        try {
          await restoreSnapshotFiles(cwd, { target: safety.commit, current: target.commit, indexFile: join(STATE_DIR, 'snapshots', uid, 'index-recover') });
        } catch (undo) {
          throw new CoreError(500, `restore failed (${why}), and putting your files back failed too (${(undo as Error).message}). Your files may be partly restored: restore the safety snapshot "${safety.promptExcerpt}" to get back to where you were.`);
        }
        throw new CoreError(400, `restore failed: ${why}. Your files are as they were.`);
      }
      return { safety, restored: target };
    });
    // Told after the input lock is released (send takes the same lock): the
    // agent's picture of its files must not silently diverge from disk, so a
    // failure to tell it is reported rather than dropped.
    let notified = true;
    if (w?.agent) {
      notified = await this.send(uid, `Your files were rolled back to the state before turn ${turn} by the user. Run git status and re-read changed files before continuing.`, true).then(
        () => true,
        (err) => (console.warn(`telling ${uid} about its rollback failed:`, err), false),
      );
    }
    return { ...out, notified };
  }

  /**
   * Retention (F39): snapshots live for the session's life plus retentionDays
   * after it ends, and each session keeps at most keepTurns of them. Pruned
   * rows lose their git refs too, so their commits become collectable.
   */
  pruneSnapshots(): Promise<void> {
    return this.snapshots.prune();
  }

  // ---------- small mutations

  /** Handoff: a device says which session it is on. The next tick tells the others. */
  focus: Focus | null = null;
  setFocus(f: Omit<Focus, 'at'>) {
    this.focus = { ...f, at: Date.now() };
    this.tick().catch(() => {});
  }

  setPinned(ref: string, pinned: boolean) {
    if (!this.registry.get(ref)) throw new CoreError(404, 'only sessions ah has run can be pinned');
    this.registry.setMeta(ref, 'ah.pinned', pinned || undefined);
    this.tick().catch(() => {});
  }

  /**
   * Manual sidebar order (F43). Sparse keys: existing orders keep their gaps,
   * so inserting between two sessions never rewrites every record.
   */
  /** Resolves once the new order is in state, so a fetch right after the request never sees the old one. */
  setOrder(uid: string, order: number): Promise<void> {
    const rec = this.registry.get(uid);
    if (!rec) throw new CoreError(404, 'only sessions ah has run can be reordered');
    if (!Number.isFinite(order)) throw new CoreError(400, 'invalid order');
    this.registry.setMeta(uid, 'ah.order', order);
    return this.tick().then(
      () => {},
      () => {},
    );
  }

  /** Next order key: max existing + 100, so new sessions land at the end. */
  nextOrder(): number {
    // Two sessions created at once both read the same maximum before either is
    // registered: the key handed out last counts too, so each gets its own place.
    let max = this.lastOrder;
    for (const r of this.registry.all()) {
      const o = r.meta['ah.order'];
      if (typeof o === 'number' && Number.isFinite(o) && o > max) max = o;
    }
    this.lastOrder = max + 100 || 100;
    return this.lastOrder;
  }
  private lastOrder = 0;

  /** Every conversation History has in one project (a Space), not only the newest 150 it shows. */
  async historyRefs(space: string): Promise<string[]> {
    const state = await this.current();
    const place = (chosen: string | null | undefined, cwd: string) => this.placeSpace(chosen, projectOf(expandHome(cwd)).projectPath);
    return (await buildHistory(this.registry, state.windows, (h) => h.space === space && !this.hidden.has(h.ref), Infinity, place)).map((h) => h.ref);
  }

  async forget(ref: string) {
    const rec = this.registry.get(ref);
    if (rec && (rec.lifecycle === 'live' || rec.lifecycle === 'starting')) throw new CoreError(409, 'session is running', 'running');
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

/** The harnesses whose subagents ah reads: every agent with a transcript, one path (server/subagents). A shell has no feed. */
function subagentHarness(adapter: string | undefined | null): SubagentHarness | null {
  return adapter === 'claude' || adapter === 'codex' || adapter === 'gemini' || adapter === 'grok' || adapter === 'hermes' || adapter === 'muse' || adapter === 'opencode' ? adapter : null;
}
