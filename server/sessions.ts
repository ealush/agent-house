// Turns raw tmux windows into the model the UI shows: which agent is running,
// which project it belongs to, and whether it is working, waiting on you or done.
// Every window is registered (F3), so it can be found and resumed from anywhere.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { capturePane, listWindows, setWindowOption, type RawWindow } from './tmux.ts';
import { Registry, type SessionRecord } from './registry.ts';
import { snapshot, descendants } from './procs.ts';
import { discover, type Transcript } from './discovery.ts';
import type { Config, Preset } from './config.ts';

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
};

export type Ask = { kind: 'command' | 'tool' | 'question' | 'screen'; text: string };

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
  /** A live shell command below the agent, even when it prints no output. */
  toolRunning?: boolean;
};

export function computeStatus(s: StatusInput): { status: Status; source: WindowView['statusSource'] } {
  const quiet = s.now - s.activity >= s.idleAfter;
  const unread = (t: number) => t > s.seen && s.viewers === 0;
  if (s.hook) {
    const { state, at } = s.hook;
    if (state === 'waiting') return { status: 'waiting', source: 'hook' };
    // An interrupted turn may never send Stop; long silence overrides "working".
    if (state === 'working') return { status: s.toolRunning || s.now - Math.max(s.activity, at) < 30 ? 'busy' : unread(s.activity) ? 'attention' : 'idle', source: 'hook' };
    if (state === 'done' || state === 'idle') return { status: unread(at) ? 'attention' : quiet ? 'idle' : 'busy', source: 'hook' };
  }
  if (quiet && s.screenWaiting) return { status: 'waiting', source: 'screen' };
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

/** Last non-empty lines of a window's visible screen, re-captured only when it printed something. */
const screenCache = new Map<string, { activity: number; lines: string[] }>();

async function screenTail(windowId: string, activity: number): Promise<string[]> {
  const hit = screenCache.get(windowId);
  if (hit?.activity === activity) return hit.lines;
  const text = await capturePane(windowId, 0).catch(() => '');
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  screenCache.set(windowId, { activity, lines: lines.slice(-12) });
  return lines.slice(-12);
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
      const quiet = now - w.activity >= config.idleAfter;
      const tail = await screenTail(w.windowId, w.activity);
      const rules = agent ? (waitingRules.get(agent) ?? []) : [];
      const asks = !hooked && !!agent && quiet && rules.length > 0 && screenAsks(tail, rules);
      const { status, source } = computeStatus({
        now,
        activity: w.activity,
        seen,
        viewers,
        idleAfter: config.idleAfter,
        hook: hooked ? { state: w.hookState, at: w.hookAt } : null,
        screenWaiting: asks,
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
        ask = hooked ? (parseJson<Ask>(w.hookAsk) ?? { kind: 'question', text: 'Waiting for your input' }) : { kind: 'screen', text: tail.slice(-4).join('\n') };
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
        answerable: status === 'waiting' && ask?.kind !== 'question' && !!preset?.approveKeys?.length,
        viewers,
        devices,
        activity: w.activity,
        createdAt: w.createdAt,
        panes: w.panes,
        pinned: !!rec.meta['ah.pinned'],
        queued: (rec.meta['ah.queue'] as unknown[] | undefined)?.length ?? 0,
        order: typeof rec.meta['ah.order'] === 'number' ? (rec.meta['ah.order'] as number) : null,
        launch,
        launchModel: typeof rec.meta['ah.launch.model'] === 'string' ? (rec.meta['ah.launch.model'] as string) : null,
        launchEffort: typeof rec.meta['ah.launch.effort'] === 'string' ? (rec.meta['ah.launch.effort'] as string) : null,
        launchMode: typeof rec.meta['ah.launch.mode'] === 'string' ? (rec.meta['ah.launch.mode'] as string) : null,
        feed: preset?.feed ?? null,
      };
    }),
  );
  registry.reconcile(alive);
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
  const claimed = new Set(windows.map((w) => w.harnessId).filter(Boolean));
  const cwdOf = (w: WindowView) => (w.cwd.startsWith('~') ? HOME + w.cwd.slice(1) : w.cwd);
  for (const w of windows) {
    if (!w.agent || w.harnessId) continue;
    const match = transcripts.find(
      (t) =>
        t.harness === w.agent &&
        t.cwd === cwdOf(w) &&
        !claimed.has(t.harnessId) &&
        (w.createdAt ? t.updatedAt >= w.createdAt - 60 : Math.abs(t.updatedAt - w.activity) < 300),
    );
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
    });
  }
  return items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at).slice(0, 150);
}

function fromRecord(r: SessionRecord, t?: Transcript): HistoryItem {
  const wt = r.meta['ah.worktree'] as { path: string } | undefined;
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
  };
}
