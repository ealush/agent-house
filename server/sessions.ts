// Turns raw tmux windows into the model the UI shows: which agent is running,
// which project it belongs to, and whether it is working, waiting on you or done.
// Every window is registered (F3), so it can be found and resumed from anywhere.
import { createHash } from 'node:crypto';
import type { RecoveryView } from './recovery/engine.ts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { interruptedOf, type Interrupted } from './interruptions.ts';
import { capturePane, listWindows, setWindowOption, TERMINAL_PREFIX, type RawWindow } from './tmux.ts';
import { Registry, forkMetaOf, type SessionRecord } from './registry.ts';
import { procTree, withArgv, descendants } from './procs.ts';
import { discover, type Transcript } from './discovery.ts';
import type { Config, Preset } from './config.ts';
import { screenAudit } from './audit.ts';
import { compileGates, pickerAtBottom, readGate, type Gate } from './agentgate.ts';
import { parsePicker, parseQuestionDialog, pickerAtStart, type Question, type ScreenOption, type ScreenQuestion } from './choices.ts';

// busy: working · waiting: needs your input/permission · attention: finished since
// you last looked · idle: nothing new. When unsure we say done/idle, never "waiting".
export type Status = 'busy' | 'idle' | 'waiting' | 'attention';

export type AttachedTerminal = { id: string; cwd: string; command: string; busy: boolean };

export type WindowView = {
  terminal?: AttachedTerminal | null;
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
  /** The agent hit its plan's usage limit: "Session limit · resets 12am", until that time passes. */
  limit: string | null;
  /** When that limit resets (epoch seconds), when the notice says. */
  limitResetsAt?: number | null;
  /** What a waiting session is blocked on, for the Inbox card. */
  ask: Ask | null;
  /** Whether one-tap Approve/Deny applies (a permission prompt with known keys). */
  answerable: boolean;
  /**
   * The prompt it's waiting on, as an opaque fingerprint of `ask` (null when not waiting).
   * A notification's Approve/Deny carries the one it showed; a different one now refuses it.
   */
  askId: string | null;
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
  /** Portable lineage: this session continues another conversation (server/portable). Null when it doesn't. */
  continued: Continued | null;
  /** Something went wrong and ah is (or could be) keeping it going (server/recovery). */
  recovery?: RecoveryView | null;
  /**
   * The last thing said in its conversation (the agent's reply, or the person's message
   * while it works on it), plain and clipped, for lists to show as a chat shows its last
   * message. Null until its transcript has been read, or for agents without one.
   */
  reply?: { role: 'assistant' | 'user'; text: string; at: number } | null;
};

/**
 * Where a session's conversation came from, when ah carried it over from another one
 * (`ah.continued` meta). `kind` says what transferred: `portable` a reconstructed
 * record, `fork` a native copy, `migration` the transcript from another host.
 */
export type Continued = { linkId: string; fromUid: string | null; fromHarness: string; fromTitle: string; fromHost?: string; kind: 'resume' | 'fork' | 'portable' | 'import' | 'migration'; strategy: string; at: number };

export function continuedOf(r: SessionRecord): Continued | null {
  const c = r.meta['ah.continued'] as Partial<Continued> | undefined;
  if (!c || typeof c.linkId !== 'string' || typeof c.fromHarness !== 'string' || typeof c.kind !== 'string') return null;
  return {
    linkId: c.linkId,
    fromUid: typeof c.fromUid === 'string' ? c.fromUid : null,
    fromHarness: c.fromHarness,
    fromTitle: typeof c.fromTitle === 'string' ? c.fromTitle : '',
    ...(typeof c.fromHost === 'string' ? { fromHost: c.fromHost } : {}),
    kind: c.kind,
    strategy: typeof c.strategy === 'string' ? c.strategy : '',
    at: typeof c.at === 'number' ? c.at : 0,
  };
}

export type Ask = {
  kind: 'command' | 'tool' | 'question' | 'screen' | 'choice';
  text: string;
  /** `choice`: the agent's multiple-choice questions (Claude's AskUserQuestion), answerable from the GUI. */
  questions?: Question[];
  /** A numbered picker on screen ("1. Yes / 2. Yes, don't ask again / 3. No"); each one is a key to type. */
  options?: ScreenOption[];
  /** The agent's startup folder-trust prompt (Preset.trust); `accept` is the option that trusts the folder. */
  trust?: { accept: string };
  /**
   * A screen in front of the agent's prompt (its trust question, a sign-in, setup):
   * a message waits in the queue until it's answered. Its links, code and input box.
   */
  gate?: Gate;
  /** `choice` without usable `questions`: the one question the dialog shows now, answered a step at a time. */
  dialog?: ScreenQuestion;
};

/**
 * A short, stable fingerprint of what a waiting session asks: the same prompt on screen
 * gives the same id, any change to its text or choices a new one. Opaque to clients.
 */
export function askFingerprint(ask: Ask | null): string | null {
  if (!ask) return null;
  const options = (ask.options ?? []).map((o) => `${o.key}=${o.label}`).join('\u0001');
  return createHash('sha256').update(`${ask.kind}\u0000${ask.text}\u0000${options}`).digest('hex').slice(0, 16);
}

/**
 * Claude Code's question dialog: its footer, and the free-text row only that dialog has; or,
 * with option previews, the notes hint its footer carries instead.
 */
const QUESTION_DIALOG = /Enter to select/;
/** The dialog's last step: a review with "1. Submit answers / 2. Cancel". */
const isQuestionReview = (tail: string[]) => {
  const text = tail.join('\n');
  return /Ready to submit your answers\?/.test(text) && /^\s*❯\s*\d\.\s+(Submit answers|Cancel)/m.test(text);
};
export const isQuestionDialog = (tail: string[]) => {
  const text = tail.join('\n');
  return QUESTION_DIALOG.test(text) && (/Type something/.test(text) || /n to add notes/.test(text));
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
  /** Portable lineage: the conversation this one continues (see WindowView.continued). */
  continued: Continued | null;
  /** Moved to another host (server/migrate): the conversation goes on there; this copy stays as it was. */
  moved?: { host: string; uid: string; at: number } | null;
  /** A crash or failure ah is (or could be) recovering from (server/recovery). */
  recovery?: RecoveryView | null;
  /** It didn't end, it was cut off: the tmux server stopped, the host restarted, its window closed mid-turn (server/interruptions). */
  interrupted?: Interrupted | null;
};

const HOME = homedir();

// ---------- git

type Repo = { root: string; project: string; branch: string | null; worktree: boolean };
const repoCache = new Map<string, { found: { root: string; gitDir: string; main: string } | null; at: number }>();
/** A folder that wasn't a repository is asked again after this: `git init` makes it one. */
const NO_REPO_TTL = 5_000;

function findRepo(dir: string) {
  const hit = repoCache.get(dir);
  // Kept: a repository while its .git is there, and "none" for a few seconds.
  if (hit && (hit.found ? existsSync(join(hit.found.root, '.git')) : Date.now() - hit.at < NO_REPO_TTL)) return hit.found;
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
  repoCache.set(dir, { found, at: Date.now() });
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
  // Home is a place, not a folder name: "~" read as a dash in small caps in the sidebar.
  return { project: repo?.project ?? (path === HOME ? 'Home' : basename(path)), projectPath: shortPath(path) };
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

/**
 * The names a process goes by, for telling which agent it is: its executable and
 * the program it runs. An interpreter's flags come before its script
 * ("node --max-old-space-size=14440 …/bundle/gemini.js", Gemini CLI 0.64), and a
 * script it runs answers to its name without the extension.
 */
export function processNames(argv: string[]): string[] {
  const exe = basename(argv[0] ?? '');
  if (!/^(node|bun|deno)$/.test(exe)) return [exe, ...(argv[1] ? [basename(argv[1])] : [])];
  const script = argv.slice(1).find((a) => !a.startsWith('-'));
  return [exe, ...(script ? [basename(script).replace(/\.[cm]?js$/, '')] : [])];
}

function detectAgent(w: RawWindow, procs: Awaited<ReturnType<typeof procTree>>, matchers: Array<[string, RegExp]>) {
  // Shell wrappers often exec the agent, replacing the pane's root process.
  for (const proc of descendants(procs, w.panePid, true)) {
    const names = processNames(proc.argv);
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
export function hasToolWork(procs: Awaited<ReturnType<typeof procTree>>, agentPid: number): boolean {
  return descendants(procs, agentPid).some((p) =>
    /^(ba|da|z|fi|k)?sh$/.test(basename(p.argv[0] ?? '')) &&
    p.argv.slice(1).some((a) => /^-[^-]*c/.test(a)),
  );
}

/** Terminal rules (F18): does the bottom of the screen look like a question? */
/**
 * The permission mode an agent's footer says is on ("⏵⏵ accept edits on"), from its
 * bottom lines only, where the conversation above can't put the same words.
 */
export function footerMode(tail: string[], detect: Record<string, string>): string | null {
  const bottom = tail.filter((l) => l.trim()).slice(-8).reverse();
  for (const line of bottom) for (const [id, text] of Object.entries(detect)) if (line.includes(text)) return id;
  return null;
}

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

const SHELLS = /^-?(bash|zsh|fish|sh|dash|ksh|mksh|tcsh|nu|xonsh|elvish)$/;

/**
 * Is the pane's shell sitting at its prompt? It is when it holds the
 * terminal's foreground and runs no script (`bash -c …` is a program, not a
 * prompt). Without a process table (not Linux), a quiet shell counts as idle.
 */
export function atShellPrompt(command: string, procs: Awaited<ReturnType<typeof procTree>>, panePid: number, quiet: boolean): boolean {
  if (!SHELLS.test(command)) return false;
  const root = descendants(procs, panePid, true).find((p) => p.pid === panePid);
  if (!root || root.fg === undefined) return quiet;
  return root.fg && !root.argv.slice(1).some((a) => /^-\w*c\w*$/.test(a));
}

/**
 * A shell's command that is still running stays working between the lines it prints, for
 * three quiet periods: one printing every few seconds otherwise flipped between working
 * and new output each tick, its row hopping between Inbox sections. Back at its prompt,
 * a shell is idle on the usual quiet period.
 */
export function commandBusy(atPrompt: boolean, now: number, activity: number, idleAfter: number): boolean {
  return !atPrompt && now - activity < idleAfter * 3;
}

/**
 * A shell's one-liner: its latest output while a command runs, or, at the
 * prompt, the command it last ran ("$ git status") — never the prompt itself.
 * The previous prompt line carries what was typed at it; a prompt that changed
 * since (a new git state, a clock) matches by its first word and final symbol.
 */
export function shellDetail(lines: string[], atPrompt: boolean): string | null {
  if (!lines.length) return null;
  const prompt = lines[lines.length - 1].trim();
  if (!atPrompt) return clip(prompt);
  const first = prompt.split(/\s+/)[0];
  const symbol = prompt.split(/\s+/).pop()!;
  for (let i = lines.length - 2; i >= 0; i--) {
    const line = lines[i].trim();
    let typed: string | null = null;
    if (line.startsWith(`${prompt} `)) typed = line.slice(prompt.length);
    else if (prompt.includes(' ') && line.startsWith(`${first} `)) {
      const at = line.indexOf(` ${symbol} `);
      if (at >= 0) typed = line.slice(at + symbol.length + 2);
    }
    if (typed?.trim()) return clip(`$ ${typed.trim()}`);
  }
  return null;
}

/**
 * The scrollback a shell's last command is looked for in. Kept apart from
 * screenTail on purpose: status reads only the visible screen, so an old
 * prompt in the scrollback can never make a session look like it needs you.
 */
const scrollCache = new Map<string, { activity: number; lines: string[] }>();
async function promptScroll(windowId: string, activity: number): Promise<string[]> {
  const hit = scrollCache.get(windowId);
  if (hit?.activity === activity) return hit.lines;
  const text = await capturePane(windowId, 200).catch(() => '');
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  scrollCache.set(windowId, { activity, lines });
  return lines;
}

/**
 * An agent's usage-limit notice at the bottom of its screen, as the CLIs word it:
 * Claude "You've hit your session limit · resets 12am (Asia/Jerusalem)", Codex
 * "You've hit your usage limit. … try again at 11:33 AM." `at`: when ah first saw
 * it; the notice stays on screen after the reset, so it counts only until then.
 */
export function screenLimit(tail: string[], at: number, now: number): string | null {
  const text = tail.slice(-15).join(' ');
  const claude = text.match(/You['’]ve hit your (\w+) limit\s*·\s*resets\s+([^(·]+?)\s*(?:\(|·|$)/i);
  const codex = text.match(/You['’]ve hit your usage limit\b.*?try again at\s+((?:[A-Z][a-z]{2} \d{1,2},? )?\d{1,2}(?::\d{2})?\s*[ap]\.?m)/i);
  const kind = claude ? `${claude[1][0].toUpperCase()}${claude[1].slice(1).toLowerCase()} limit` : codex ? 'Usage limit' : null;
  const when = (claude?.[2] ?? codex?.[1])?.trim();
  if (!kind || !when) return null;
  const resets = resetTime(when, at);
  if (resets !== null && now >= resets) return null;
  return `${kind} · resets ${when}`;
}

/** The first moment after `from` (epoch seconds) that reads "12am", "1:50am", "11:33 AM" or "Oct 16, 7am"; null if unreadable. */
export function resetTime(when: string, from: number): number | null {
  const clock = when.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i);
  if (!clock) return null;
  const h = (Number(clock[1]) % 12) + (clock[3].toLowerCase() === 'p' ? 12 : 0);
  const m = Number(clock[2] ?? 0);
  const day = when.match(/\b([A-Z][a-z]{2})\s+(\d{1,2})\b/);
  const t = new Date(from * 1000);
  if (day) {
    const month = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(day[1]) / 3;
    if (month >= 0 && Number.isInteger(month)) t.setMonth(month, Number(day[2]));
  }
  t.setHours(h, m, 0, 0);
  if (!day && t.getTime() / 1000 <= from) t.setDate(t.getDate() + 1);
  return t.getTime() / 1000;
}

const limitSeen = new Map<string, { text: string; at: number }>();

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

/**
 * `launching`: windows ah is still setting up (core.launch). One listed before its
 * @ah-uid landed is left out of this pass, never stamped with a uid of its own:
 * that would replace the one launch chose, and the session would vanish under it.
 */
export async function buildWindows(config: Config, viewerMap: Map<string, string[]>, registry: Registry, launching: ReadonlySet<string> = new Set()): Promise<WindowView[]> {
  const [raw, tree] = await Promise.all([listWindows(), procTree()]);
  const procs = await withArgv(tree, raw.map((w) => w.panePid));
  const forkCounts = new Map<string, number>();
  for (const r of registry.all()) {
    const f = forkMetaOf(r);
    if (f) forkCounts.set(f.parentUid, (forkCounts.get(f.parentUid) ?? 0) + 1);
  }
  const matchers = compileMatchers(config.presets);
  const waitingRules = new Map(config.presets.map((p) => [p.id, (p.waitingPatterns ?? []).map((s) => new RegExp(s, 'm'))]));
  const gateRules = new Map(config.presets.map((p) => [p.id, compileGates(p)]));
  const now = Date.now() / 1000;
  const alive = new Set<string>();
  const waitingEpisodes = new Set<string>();

  const views = await Promise.all(
    raw.map(async (w): Promise<WindowView | null> => {
      if (w.session.startsWith(TERMINAL_PREFIX)) return null;
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
      // A screen in front of the prompt (trust, sign-in, setup) is read hooks or not:
      // an agent's hooks don't run before its folder is trusted or it's signed in.
      const gate = agent ? readGate(tail, gateRules.get(agent) ?? { rules: [] }) : null;
      // Any other picker drawn at the bottom of a hookless agent's screen is a question
      // too (an update offer, a first-run choice): its rules may not know it, and a
      // message typed into it would be lost the same way.
      const picked = !hooked && !!agent && !gate && pickerAtBottom(tail);
      const asks = !hooked && !!agent && quiet && ((rules.length > 0 && screenAsks(tail, rules)) || picked);
      // A prompt the hook reports is a free test of the screen rules hookless sessions use
      // (server/audit.ts). Its first moments are skipped: the TUI may not have drawn it yet.
      if (hooked && agent && hookState === 'waiting' && now - w.hookAt >= 1.5) {
        const key = `${w.windowId}:${w.hookAt}`;
        const sees = rules.length > 0 && (isQuestionDialog(tail) || isQuestionReview(tail) || (screenAsks(tail, rules) && !!parsePicker(tail)) || (quiet && screenAsks(tail, rules)));
        screenAudit.observe(key, agent, sees, hookAsk?.kind ?? 'prompt', tail.join('\n'));
        waitingEpisodes.add(key);
      }
      const { status, source } = computeStatus({
        now,
        activity: w.activity,
        seen,
        viewers,
        idleAfter: config.idleAfter,
        quiet,
        hook: hooked && !gate ? { state: hookState, at: w.hookAt } : null,
        screenWaiting: asks,
        // A drawn picker is unambiguous, so it needs no quiet period (Claude redraws
        // a permission prompt every second, which would otherwise read as working):
        // the question dialog, its review step, or a prompt rule over a numbered picker.
        dialog: !!gate || (!hooked && !!agent && rules.length > 0 && (isQuestionDialog(tail) || isQuestionReview(tail) || (screenAsks(tail, rules) && !!parsePicker(tail)))),
        toolRunning: detected ? hasToolWork(procs, detected.pid) : commandBusy(atShellPrompt(w.command, procs, w.panePid, quiet), now, w.activity, config.idleAfter),
      });

      // Register every window, shells included (F3).
      let uid = w.uid;
      if (!uid && launching.has(w.windowId)) return null;
      if (!uid) {
        uid = registry.freshId();
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
      if (status === 'waiting' && gate) {
        ask = {
          kind: 'screen',
          text: gate.text || (gate.gate.kind === 'trust' ? 'Trust this folder?' : 'Sign in'),
          ...(gate.options ? { options: gate.options } : {}),
          gate: gate.gate,
          ...(gate.accept ? { trust: { accept: gate.accept } } : {}),
        };
      } else if (status === 'waiting') {
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
      // The mode on screen beats the launch flag: Shift+Tab in the terminal, or a
      // default mode from the agent's own settings, changes it without ah.
      const liveMode = preset?.modeCycle && status !== 'waiting' ? footerMode(tail, preset.modeCycle.detect) : null;
      if (liveMode && liveMode !== (rec.meta['ah.launch.mode'] ?? 'default')) registry.setMeta(uid, 'ah.launch.mode', liveMode === 'default' ? undefined : liveMode);
      // Agents' own TUIs make poor one-liners; for them only hook activity is shown.
      // A limit notice is what a stopped agent is waiting on; ah first saw it at `at`.
      let limit: string | null = null;
      let limitResetsAt: number | null = null;
      if (agent) {
        const notice = tail.slice(-15).find((l) => /You['’]ve hit your/.test(l)) ?? '';
        const seenAt = notice ? (limitSeen.get(w.windowId)?.text === notice ? limitSeen.get(w.windowId)!.at : now) : 0;
        if (notice) limitSeen.set(w.windowId, { text: notice, at: seenAt });
        else limitSeen.delete(w.windowId);
        limit = notice ? screenLimit(tail, seenAt, now) : null;
        const when = limit?.match(/resets (.+)$/)?.[1];
        limitResetsAt = when ? resetTime(when, seenAt) : null;
      }
      const prompt = !agent && !hookDetail && atShellPrompt(w.command, procs, w.panePid, quiet);
      const detail = limit && status !== 'busy' && status !== 'waiting'
        ? limit
        : hookDetail
        ? hookDetail.kind === 'command' ? `$ ${hookDetail.text}` : hookDetail.text
        : agent ? null : shellDetail(prompt ? await promptScroll(w.windowId, w.activity) : tail, prompt);
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
        limit: status === 'busy' || status === 'waiting' ? null : limit,
        limitResetsAt: status === 'busy' || status === 'waiting' ? null : limitResetsAt,
        ask,
        // Approve / Deny type the preset's keys: never into a sign-in or trust screen.
        answerable: status === 'waiting' && ask?.kind !== 'question' && ask?.kind !== 'choice' && !ask?.gate && !!preset?.approveKeys?.length,
        askId: status === 'waiting' ? askFingerprint(ask) : null,
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
        continued: continuedOf(rec),
      };
    }),
  );
  registry.reconcile(alive);
  screenAudit.sweep(waitingEpisodes);
  // Screens of dead windows never change again; drop their clocks.
  const liveIds = new Set(raw.map((w) => w.windowId));
  for (const id of contentClock.keys()) if (!liveIds.has(id)) contentClock.delete(id);
  for (const id of limitSeen.keys()) if (!liveIds.has(id)) limitSeen.delete(id);
  for (const id of screenCache.keys()) if (!liveIds.has(id)) screenCache.delete(id);
  for (const id of scrollCache.keys()) if (!liveIds.has(id)) scrollCache.delete(id);
  const visible = views.filter((v): v is WindowView => v !== null);
  for (const v of visible) {
    const terminal = raw.find((w) => w.session === TERMINAL_PREFIX + v.uid);
    v.terminal = terminal ? terminalView(terminal, procs) : null;
  }
  return visible;
}

export function terminalView(w: RawWindow, procs: Awaited<ReturnType<typeof procTree>>): AttachedTerminal {
  return { id: w.windowId, cwd: shortPath(w.path), command: w.command, busy: !atShellPrompt(w.command, procs, w.panePid, true) };
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
    // One conversation can span several files (Codex writes a new rollout on resume): newest wins.
    claimed.add(t.harnessId);
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
      continued: null,
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
    continued: continuedOf(r),
    moved: movedOf(r),
    interrupted: interruptedOf(r),
  };
}

function movedOf(r: SessionRecord): { host: string; uid: string; at: number } | null {
  const m = r.meta['ah.movedTo'] as { host?: unknown; uid?: unknown; at?: unknown } | undefined;
  return m && typeof m.host === 'string' && typeof m.uid === 'string' ? { host: m.host, uid: m.uid, at: typeof m.at === 'number' ? m.at : 0 } : null;
}
