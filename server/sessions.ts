// Turns raw tmux windows into the model the UI shows: which agent is running,
// which project it belongs to, and whether it is working, waiting on you or done.
// Every window is registered (F3), so it can be found and resumed from anywhere.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { capturePane, listWindows, setWindowOption, type RawWindow } from './tmux.ts';
import { Registry, forkMetaOf, type SessionRecord } from './registry.ts';
import { snapshot, descendants } from './procs.ts';
import { discover, type Transcript } from './discovery.ts';
import type { Config, Preset } from './config.ts';
import { parsePicker, parseQuestionDialog, pickerAtStart, type Question, type ScreenOption, type ScreenQuestion } from './choices.ts';

// busy: working · waiting: needs your input/permission · attention: finished since
// you last looked · idle: nothing new. When unsure we say done/idle, never "waiting".
export type Status = 'busy' | 'idle' | 'waiting' | 'attention';

export type WindowView = {
  id: string;
  session: string;
  index: number;
  name: string;
  /** Best human title: the conversation's own title when the window name is generic. */
  title: string;
  uid: string;
  agent: string | null;
  harnessId: string | null;
  model: string | null;
  /** Where the status came from: agent hooks, terminal rules, or output activity. */
  statusSource: 'hook' | 'screen' | 'activity';
  command: string;
  cwd: string;
  project: string;
  projectPath: string;
  branch: string | null;
  worktree: boolean;
  status: Status;
  /** One line of what's happening: hook activity, or the last line on screen. */
  detail: string | null;
  /** What a waiting session is blocked on, for the Inbox card. */
  ask: Ask | null;
  /** Whether one-tap Approve/Deny applies (a permission prompt with known keys). */
  answerable: boolean;
  viewers: number;
  /** Labels of the devices currently viewing ("iPad", "Mac"). */
  devices: string[];
  activity: number;
  createdAt: number;
  panes: number;
  pinned: boolean;
  queued: number;
  /** Manual sidebar order (F43): sparse `ah.order` key, null when never arranged. */
  order: number | null;
  /** Launch summary (F42): "Opus · Skip permissions", from `ah.launch.*` meta. */
  launch: string | null;
  /** Raw launch choices (ids), for the composer's model/effort chip. */
  launchModel: string | null;
  launchEffort: string | null;
  launchMode: string | null;
  /** Transcript adapter for the GUI view (server/feed), null for terminal-only agents. */
  feed: string | null;
  /** Fork lineage (F36): this session is a fork, and how many forks it has. Null when neither. */
  fork: { parentUid: string; parentTitle: string; rootUid: string; forks: number } | null;
};

export type Ask = {
  kind: 'command' | 'tool' | 'question' | 'screen' | 'choice';
  text: string;
  /** `choice`: the agent's multiple-choice questions (Claude's AskUserQuestion), answerable from the GUI. */
  questions?: Question[];
  /** A numbered picker on screen ("1. Yes / 2. Yes, don't ask again / 3. No"); each one is a key to type. */
  options?: ScreenOption[];
  /** `choice` without usable `questions`: the one question the dialog shows now, answered a step at a time. */
  dialog?: ScreenQuestion;
};

/** Claude Code's question dialog: its footer, and the free-text row only that dialog has. */
const QUESTION_DIALOG = /Enter to select/;
/** The dialog's last step: a review with "1. Submit answers / 2. Cancel". */
const isQuestionReview = (tail: string[]) => {
  const text = tail.join('\n');
  return /Ready to submit your answers\?/.test(text) && /^\s*❯\s*\d\.\s+(Submit answers|Cancel)/m.test(text);
};
export const isQuestionDialog = (tail: string[]) => {
  const text = tail.join('\n');
  return QUESTION_DIALOG.test(text) && /Type something/.test(text);
};

export type HistoryItem = {
  /** Registry id for sessions ah ran, `harness:harnessId` for discovered ones. */
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
  /** Fork lineage (F36): the title of the session this one was forked from. */
  fork: { parentTitle: string } | null;
};

const HOME = homedir();

// ---------- git

type Repo = { root: string; project: string; branch: string | null; worktree: boolean };
const repoCache = new Map<string, { root: string; gitDir: string; main: string } | null>();

function findRepo(dir: string) {
  if (repoCache.has(dir)) return repoCache.get(dir)!;
  let found: { root: string; gitDir: string; main: string } | null = null;
  for (let cur = dir; cur && cur !== '/'; cur = dirname(cur)) {
    const dotgit = join(cur, '.git');
    if (!existsSync(dotgit)) continue;
    let gitDir = dotgit;
    let main = cur;
    try {
      if (statSync(dotgit).isFile()) {
        // Linked worktree: ".git" is a file pointing at <main>/.git/worktrees/<name>.
        gitDir = resolve(cur, readFileSync(dotgit, 'utf8').replace(/^gitdir:\s*/, '').trim());
        const i = gitDir.indexOf('/.git/worktrees/');
        if (i >= 0) main = gitDir.slice(0, i);
      }
    } catch {}
    found = { root: cur, gitDir, main };
    break;
  }
  repoCache.set(dir, found);
  return found;
}

export function repoInfo(dir: string): Repo | null {
  const r = findRepo(dir);
  if (!r) return null;
  let branch: string | null = null;
  try {
    const head = readFileSync(join(r.gitDir, 'HEAD'), 'utf8').trim();
    branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
  } catch {}
  return { root: r.root, project: basename(r.main), branch, worktree: r.main !== r.root };
}

export function shortPath(p: string): string {
  return p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p;
}

/** Display summary from stored `ah.launch.*` meta: "Opus · Skip permissions". */
export function launchSummary(rec: SessionRecord, preset?: Preset): string | null {
  const modeId = rec.meta['ah.launch.mode'];
  const modelId = rec.meta['ah.launch.model'];
  const effort = rec.meta['ah.launch.effort'];
  const parts: string[] = [];
  if (typeof modelId === 'string') {
    const m = preset?.models?.find((x) => x.id === modelId);
    parts.push(m ? m.name : modelId);
  }
  if (typeof effort === 'string') parts.push(effort);
  if (typeof modeId === 'string') {
    const m = preset?.modes?.find((x) => x.id === modeId);
    parts.push(m ? m.name : modeId);
  }
  return parts.length ? parts.join(' · ') : null;
}

function projectOf(dir: string): { project: string; projectPath: string } {
  const repo = repoInfo(dir);
  const path = repo?.root ?? dir;
  return { project: repo?.project ?? (path === HOME ? '~' : basename(path)), projectPath: shortPath(path) };
}

// ---------- agent detection

function compileMatchers(presets: Preset[]): Array<[string, RegExp]> {
  return presets
    .filter((p) => p.command)
    .map((p) => [p.id, new RegExp(p.match ?? `^${escape(basename(p.command.split(/\s+/)[0]))}$`)]);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectAgent(w: RawWindow, procs: Awaited<ReturnType<typeof snapshot>>, matchers: Array<[string, RegExp]>) {
  // Shell wrappers often exec the agent, replacing the pane's root process.
  for (const proc of descendants(procs, w.panePid, true)) {
    const names = proc.argv.slice(0, 2).map((a) => basename(a));
    for (const [id, re] of matchers) {
      if (names.some((n) => re.test(n))) return { id, pid: proc.pid };
    }
  }
  return null;
}

// ---------- status

export type StatusInput = {
  now: number;
  activity: number;
  seen: number;
  viewers: number;
  idleAfter: number;
  /** Hook state, only when the hooked agent is still the one running. */
  hook: { state: string; at: number } | null;
  /** True when a terminal rule says the agent is asking something (non-hooked agents). */
  screenWaiting: boolean;
  /** A question dialog is drawn: unambiguous, so it needs no quiet period. */
  dialog?: boolean;
  /** A live shell command below the agent, even when it prints no output. */
  toolRunning?: boolean;
  /**
   * Precomputed quiet (no new output AND no visible screen change for
   * `idleAfter`). tmux activity alone cannot prove work, because agent TUIs
   * repaint on a timer even while idle at their prompt. When set, it replaces
   * the activity-based check.
   */
  quiet?: boolean;
};

export function computeStatus(s: StatusInput): { status: Status; source: WindowView['statusSource'] } {
  const quiet = s.quiet ?? s.now - s.activity >= s.idleAfter;
  const unread = (t: number) => t > s.seen && s.viewers === 0;
  if (s.hook) {
    const { state, at } = s.hook;
    if (state === 'waiting') return { status: 'waiting', source: 'hook' };
    // An interrupted turn may never send Stop; long silence overrides "working".
    if (state === 'working') return { status: s.toolRunning || s.now - Math.max(s.activity, at) < 30 ? 'busy' : unread(s.activity) ? 'attention' : 'idle', source: 'hook' };
    // A finished turn stays finished: trailing tmux output is the TUI repainting
    // its idle screen, not more work (its next turn opens with a fresh hook).
    if (state === 'done' || state === 'idle') return { status: unread(at) ? 'attention' : 'idle', source: 'hook' };
  }
  if (s.dialog || (quiet && s.screenWaiting)) return { status: 'waiting', source: 'screen' };
  if (s.toolRunning) return { status: 'busy', source: 'activity' };
  if (!quiet) return { status: 'busy', source: 'activity' };
  return { status: s.seen > 0 && unread(s.activity) ? 'attention' : 'idle', source: 'activity' };
}

/** Tool shells are evidence of work; persistent MCP servers alone are not. */
export function hasToolWork(procs: Awaited<ReturnType<typeof snapshot>>, agentPid: number): boolean {
  return descendants(procs, agentPid).some((p) =>
    /^(ba|da|z|fi|k)?sh$/.test(basename(p.argv[0] ?? '')) &&
    p.argv.slice(1).some((a) => /^-[^-]*c/.test(a)),
  );
}

/** Terminal rules (F18): does the bottom of the screen look like a question? */
export function screenAsks(lines: string[], patterns: RegExp[]): boolean {
  const tail = lines.filter((l) => l.trim()).slice(-12).join('\n');
  return patterns.some((re) => re.test(tail));
}

/**
 * When the screen's visible text last changed, per window. tmux activity alone
 * cannot prove work: agent TUIs repaint on a timer while idle at their prompt,
 * so a finished session keeps looking "recent". A screen whose text has not
 * changed for `idleAfter` is quiet even while its activity ticks.
 */
const contentClock = new Map<string, { text: string; at: number }>();

export function trackContent(prev: { text: string; at: number } | undefined, text: string, activity: number, now: number): { text: string; at: number } {
  if (!prev) return { text, at: activity };
  if (prev.text === text) return prev;
  return { text, at: now };
}

/** Last non-empty lines of a window's visible screen, re-captured only when it printed something. */
const screenCache = new Map<string, { activity: number; at: number; lines: string[] }>();

async function screenTail(windowId: string, activity: number): Promise<string[]> {
  const hit = screenCache.get(windowId);
  // Activity has one-second resolution: a capture taken in the same second as the
  // last output may have missed the rest of it, so it is only reused once it is newer.
  if (hit?.activity === activity && hit.at > activity + 1) return hit.lines;
  const text = await capturePane(windowId, 0).catch(() => '');
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  // More than screenAsks reads: a permission prompt's options sit under its preview.
  // A question dialog with descriptions runs to ~30 lines.
  screenCache.set(windowId, { activity, at: Date.now() / 1000, lines: lines.slice(-40) });
  return lines.slice(-40);
}

function parseJson<T>(s: string): T | null {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------- windows

export async function buildWindows(config: Config, viewerMap: Map<string, string[]>, registry: Registry): Promise<WindowView[]> {
  const [raw, procs] = await Promise.all([listWindows(), snapshot()]);
  const forkCounts = new Map<string, number>();
  for (const r of registry.all()) {
    const f = forkMetaOf(r);
    if (f) forkCounts.set(f.parentUid, (forkCounts.get(f.parentUid) ?? 0) + 1);
  }
  const matchers = compileMatchers(config.presets);
  const waitingRules = new Map(config.presets.map((p) => [p.id, (p.waitingPatterns ?? []).map((s) => new RegExp(s, 'm'))]));
  const now = Date.now() / 1000;
  const alive = new Set<string>();

  const views = await Promise.all(
    raw.map(async (w): Promise<WindowView> => {
      const devices = viewerMap.get(w.windowId) ?? [];
      const viewers = devices.length;
      // Anything printed while someone is looking counts as read.
      let seen = w.seen;
      if (viewers > 0 && w.activity > seen) {
        seen = w.activity;
        await setWindowOption(w.windowId, '@ah-seen', String(seen)).catch(() => {});
      }

      const detected = detectAgent(w, procs, matchers);
      const agent = detected?.id ?? null;
      // Hook state is trusted only while that agent is still running in the window.
      const hooked = !!w.hookState && w.hookState !== 'ended' && agent === w.harness;
      const tail = await screenTail(w.windowId, w.activity);
      // A repaint without a visible change is not work: the clock advances only
      // when the text does, so an idle TUI's timer repaints go quiet on time.
      const content = trackContent(contentClock.get(w.windowId), tail.join('\n'), w.activity, now);
      contentClock.set(w.windowId, content);
      const quiet = now - w.activity >= config.idleAfter || now - content.at >= config.idleAfter;
      const hookAsk = hooked ? parseJson<Ask>(w.hookAsk) : null;
      // A question recorded at PreToolUse counts as waiting only while its dialog is
      // drawn: cancelling it with Esc sends no hook, and must not leave "needs you" stuck.
      let hookState = w.hookState;
      if (hooked && hookState === 'waiting' && hookAsk?.kind === 'choice' && !isQuestionDialog(tail) && !isQuestionReview(tail)) hookState = 'working';
      // A permission prompt is always a picker on screen. A hook that still says
      // "waiting" once the screen is quiet and shows none missed its next event:
      // don't keep the session on "needs you" for it.
      if (hooked && hookState === 'waiting' && (hookAsk?.kind === 'tool' || hookAsk?.kind === 'command') && quiet && !parsePicker(tail) && !isQuestionDialog(tail)) hookState = 'done';
      const rules = agent ? (waitingRules.get(agent) ?? []) : [];
      const asks = !hooked && !!agent && quiet && rules.length > 0 && screenAsks(tail, rules);
      const { status, source } = computeStatus({
        now,
        activity: w.activity,
        seen,
        viewers,
        idleAfter: config.idleAfter,
        quiet,
        hook: hooked ? { state: hookState, at: w.hookAt } : null,
        screenWaiting: asks,
        // A drawn picker is unambiguous, so it needs no quiet period (Claude redraws
        // a permission prompt every second, which would otherwise read as working):
        // the question dialog, its review step, or a prompt rule over a numbered picker.
        dialog: !hooked && !!agent && rules.length > 0 && (isQuestionDialog(tail) || isQuestionReview(tail) || (screenAsks(tail, rules) && !!parsePicker(tail))),
        toolRunning: detected ? hasToolWork(procs, detected.pid) : false,
      });

      // Register every window, shells included (F3).
      let uid = w.uid;
      if (!uid) {
        uid = Registry.newId();
        await setWindowOption(w.windowId, '@ah-uid', uid).catch(() => {});
      }
      alive.add(uid);
      const prev = registry.get(uid);
      const harness = agent ?? (w.harness || prev?.harness || (w.agentTag && w.agentTag !== 'shell' ? w.agentTag : 'shell'));
      const harnessId = w.harness === harness && w.harnessId ? w.harnessId : prev?.harness === harness ? prev?.harnessId : undefined;
      const model = w.harness === harness && w.model ? w.model : undefined;
      registry.live(uid, {
        harness,
        harnessId,
        cwd: w.path,
        model,
        title: w.name,
        status,
        tmux: { session: w.session, windowId: w.windowId },
        activity: w.activity,
        createdAt: w.createdAt || undefined,
      });

      const repo = repoInfo(w.path);
      const rec = registry.get(uid)!;
      const hookDetail = hooked ? parseJson<Ask>(w.hookDetail) : null;
      let ask: Ask | null = null;
      if (status === 'waiting') {
        ask = hooked ? (hookAsk ?? { kind: 'question', text: 'Waiting for your input' }) : { kind: 'screen', text: tail.slice(-4).join('\n') };
        if (agent && isQuestionDialog(tail)) {
          // Answered from the questions, never by its first row's digit. The hook's
          // full set answers in one go while the dialog is untouched; otherwise the
          // question on screen is answered on its own, and the next one follows.
          const dialog = parseQuestionDialog(tail);
          const whole = ask.kind === 'choice' && ask.questions?.length && pickerAtStart(tail.join('\n'), ask.questions) ? ask.questions : undefined;
          ask = { kind: 'choice', text: dialog?.question ?? (ask.kind === 'choice' ? ask.text : 'Asked a question'), ...(whole ? { questions: whole } : {}), ...(dialog ? { dialog } : {}) };
        } else if (agent) {
          const picker = parsePicker(tail);
          // What the picker is about (the command, a dialog's summary) beats the hook's one-liner.
          if (picker) ask = { ...ask, options: picker.options, text: picker.context || ask.text };
        }
      }
      const preset = agent ? config.presets.find((p) => p.id === agent) : undefined;
      // Agents' own TUIs make poor one-liners; for them only hook activity is shown.
      const detail = hookDetail ? (hookDetail.kind === 'command' ? `$ ${hookDetail.text}` : hookDetail.text) : agent ? null : tail.length ? clip(tail[tail.length - 1].trim()) : null;
      const launch = launchSummary(rec, preset);
      return {
        id: w.windowId,
        session: w.session,
        index: w.index,
        name: w.name,
        title: w.name,
        uid,
        agent,
        harnessId: rec.harnessId ?? null,
        model: agent ? (rec.model ?? null) : null,
        statusSource: source,
        command: w.command,
        cwd: shortPath(w.path),
        ...projectOf(w.path),
        branch: repo?.branch ?? null,
        worktree: repo?.worktree ?? false,
        status,
        detail,
        ask,
        answerable: status === 'waiting' && ask?.kind !== 'question' && ask?.kind !== 'choice' && !!preset?.approveKeys?.length,
        viewers,
        devices,
        activity: w.activity,
        // `@ah-created` is the launch time. A window ah found already running
        // has none, so the registry's first-seen time keeps opening order stable.
        createdAt: w.createdAt || rec.createdAt,
        panes: w.panes,
        pinned: !!rec.meta['ah.pinned'],
        queued: (rec.meta['ah.queue'] as unknown[] | undefined)?.length ?? 0,
        order: typeof rec.meta['ah.order'] === 'number' ? (rec.meta['ah.order'] as number) : null,
        launch,
        launchModel: typeof rec.meta['ah.launch.model'] === 'string' ? (rec.meta['ah.launch.model'] as string) : null,
        launchEffort: typeof rec.meta['ah.launch.effort'] === 'string' ? (rec.meta['ah.launch.effort'] as string) : null,
        launchMode: typeof rec.meta['ah.launch.mode'] === 'string' ? (rec.meta['ah.launch.mode'] as string) : null,
        feed: preset?.feed ?? null,
        fork: (() => {
          const f = forkMetaOf(rec);
          const forks = forkCounts.get(uid) ?? 0;
          if (!f && !forks) return null;
          return {
            parentUid: f?.parentUid ?? '',
            parentTitle: f ? (registry.get(f.parentUid)?.title ?? f.rootTitle) : '',
            rootUid: f?.rootUid ?? uid,
            forks,
          };
        })(),
      };
    }),
  );
  registry.reconcile(alive);
  // Screens of dead windows never change again; drop their clocks.
  const liveIds = new Set(raw.map((w) => w.windowId));
  for (const id of contentClock.keys()) if (!liveIds.has(id)) contentClock.delete(id);
  return views;
}

// ---------- transcript adoption (F10): live agent windows without hooks learn their conversation id

/**
 * Pairs live agent windows that don't know their conversation id with the transcript
 * they're most likely writing: same harness and directory, touched since the window
 * started (or around its last output, for windows ah didn't create). Hooks, when
 * present, always win over this guess.
 */
export function adoptTranscripts(windows: WindowView[], transcripts: Transcript[], registry: Registry) {
  const byId = new Map(transcripts.map((t) => [t.harnessId, t]));
  const generic = (w: WindowView) => !w.name || w.name === w.agent || w.name === w.command || /^(claude|codex|gemini|grok|muse|hermes|opencode|shell|bash|zsh|fish|node)$/.test(w.name);
  // A conversation belongs to exactly one session: ids another record already
  // owns (e.g. an ended session in the same directory) are never re-adopted,
  // so a fresh window without hooks (muse) cannot steal its history and show
  // it as its own GUI transcript while the terminal shows the live session.
  const claimed = new Set(windows.map((w) => w.harnessId).filter(Boolean));
  try {
    for (const r of registry.all?.() ?? []) if (r.harnessId) claimed.add(r.harnessId);
  } catch {}
  const cwdOf = (w: WindowView) => (w.cwd.startsWith('~') ? HOME + w.cwd.slice(1) : w.cwd);
  const knownAtLaunch = (uid: string): string[] | null => {
    const meta = registry.get?.(uid)?.meta?.['ah.knownTranscripts'];
    return Array.isArray(meta) && meta.every((s) => typeof s === 'string') ? (meta as string[]) : null;
  };
  // A transcript born long before the window cannot be its conversation;
  // without this floor an older hungry window steals a newer window's
  // transcript (both are novel to it, and discover order is newest-first).
  const BIRTH_SLOP = 120;
  for (const w of windows) {
    if (!w.agent || w.harnessId) continue;
    const known = knownAtLaunch(w.uid);
    const cands = transcripts.filter((t) => {
      if (t.harness !== w.agent || t.cwd !== cwdOf(w) || claimed.has(t.harnessId)) return false;
      if (known) {
        // Session-bound: only a conversation id that did not exist when this
        // session launched can be its transcript. Set membership, no clocks —
        // plus a birth floor, so a window whose own transcript is not visible
        // yet (no prompt submitted) cannot claim a newer window's.
        if (known.includes(t.harnessId)) return false;
        if (t.birthAt != null && w.createdAt && t.birthAt < w.createdAt - BIRTH_SLOP) return false;
        return true;
      }
      // Best-effort recency for windows ah did not launch (no launch snapshot):
      // the transcript must have been touched after the window started, or
      // around its last output when the window's age is unknown.
      return w.createdAt ? t.updatedAt >= w.createdAt : Math.abs(t.updatedAt - w.activity) < 300;
    });
    // Earliest-born first: a window binds the transcript born closest after
    // its own creation. Transcripts without a birth keep discover order
    // (newest first), as before.
    cands.sort((a, b) => {
      if (a.birthAt == null || b.birthAt == null) return 0;
      const ka = a.birthAt >= w.createdAt ? a.birthAt - w.createdAt : Infinity;
      const kb = b.birthAt >= w.createdAt ? b.birthAt - w.createdAt : Infinity;
      return ka === kb ? 0 : ka - kb;
    });
    const match = cands[0];
    if (!match) continue;
    claimed.add(match.harnessId);
    w.harnessId = match.harnessId;
    w.model ??= match.model ?? null;
    registry.adopt(w.uid, match.harnessId, match.model);
  }
  for (const w of windows) {
    const t = w.harnessId ? byId.get(w.harnessId) : undefined;
    if (t && generic(w)) w.title = t.title;
  }
}

// ---------- history (F10): ended registry records ∪ discovered transcripts, deduped by harness id

export async function buildHistory(registry: Registry, windows: WindowView[]): Promise<HistoryItem[]> {
  const transcripts = await discover();
  const running = new Set(windows.map((w) => w.harnessId).filter(Boolean));
  const byHarnessId = new Map<string, Transcript>(transcripts.map((t) => [t.harnessId, t]));
  const claimed = new Set<string>();
  const items: HistoryItem[] = [];

  for (const r of registry.all()) {
    if (r.lifecycle !== 'ended') continue;
    if (r.harnessId && running.has(r.harnessId)) continue; // resumed elsewhere already
    const t = r.harnessId ? byHarnessId.get(r.harnessId) : undefined;
    if (r.harnessId) claimed.add(r.harnessId);
    items.push(fromRecord(r, t));
  }
  for (const t of transcripts) {
    if (running.has(t.harnessId) || claimed.has(t.harnessId)) continue;
    items.push({
      ref: `${t.harness}:${t.harnessId}`,
      kind: 'saved',
      harness: t.harness,
      harnessId: t.harnessId,
      title: t.title,
      cwd: shortPath(t.cwd),
      project: projectOf(t.cwd).project,
      model: t.model ?? null,
      at: t.updatedAt,
      pinned: false,
      worktree: null,
      fork: null,
    });
  }
  return items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at).slice(0, 150);
}

function fromRecord(r: SessionRecord, t?: Transcript): HistoryItem {
  const wt = r.meta['ah.worktree'] as { path: string } | undefined;
  const fork = forkMetaOf(r);
  return {
    ref: r.id,
    kind: 'ended',
    harness: r.harness,
    harnessId: r.harnessId ?? null,
    // The window name is often just "claude"; the harness's own title is better.
    title: t && (r.title === r.harness || !r.title) ? t.title : r.title || t?.title || r.harness,
    cwd: shortPath(r.cwd),
    project: projectOf(r.cwd).project,
    model: r.model ?? t?.model ?? null,
    at: r.endedAt ?? r.lastActivityAt,
    pinned: !!r.meta['ah.pinned'],
    worktree: wt?.path ? shortPath(wt.path) : null,
    fork: fork ? { parentTitle: fork.rootTitle } : null,
  };
}
