import '../test/scratch.ts';
import { test, mock } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { agyQuota, computeStatus, flagOnlyMode, footerMode, screenAsks, adoptTranscripts, hasToolWork, turnToolWork, atShellPrompt, processNames, resetTime, screenLimit, shellDetail, trackContent, repoInfo, commandBusy, type StatusInput, type WindowView } from './sessions.ts';
import { loadConfig } from './config.ts';
import { parsePicker } from './choices.ts';
import { AGY_COMMAND_NARROW, AGY_QUOTA_NARROW, AGY_RSYNC_NARROW, AGY_TASK_AT_PROMPT, AGY_TASK_AT_PROMPT_NARROW, AGY_TURN_WITH_TASK_NARROW } from '../test/agy.ts';

const base: StatusInput = { now: 1000, activity: 900, seen: 900, viewers: 0, idleAfter: 4, hook: null, screenWaiting: false };
const status = (o: Partial<StatusInput>) => computeStatus({ ...base, ...o }).status;

test('activity heuristics', () => {
  assert.equal(status({ activity: 999 }), 'busy');
  assert.equal(status({}), 'idle');
  assert.equal(status({ activity: 950, seen: 900 }), 'attention', 'output since last look');
  assert.equal(status({ activity: 950, seen: 0 }), 'idle', 'never viewed: no unread signal');
  assert.equal(status({ activity: 950, seen: 900, viewers: 1 }), 'idle', 'someone is looking');
});

test('hooks win over heuristics', () => {
  assert.equal(status({ hook: { state: 'waiting', at: 990 } }), 'waiting');
  assert.equal(status({ activity: 990, hook: { state: 'working', at: 990 } }), 'busy');
  assert.equal(status({ activity: 900, hook: { state: 'working', at: 900 } }), 'idle', 'silent "working" is stale');
  assert.equal(status({ hook: { state: 'done', at: 950 } }), 'attention');
  assert.equal(status({ hook: { state: 'done', at: 850 } }), 'idle', 'already seen');
});

test('a finished turn never reads busy from trailing activity', () => {
  // Agent TUIs repaint their idle screen on a timer, so tmux activity stays
  // fresh after Stop: the reply on screen means idle/done, not working.
  assert.equal(status({ activity: 999, seen: 999, viewers: 1, hook: { state: 'done', at: 950 } }), 'idle');
  assert.equal(status({ activity: 999, seen: 999, hook: { state: 'idle', at: 950 } }), 'idle');
  assert.equal(status({ activity: 999, hook: { state: 'done', at: 999 } }), 'attention', 'an unseen finish still pings');
});

test('a static screen goes quiet even while activity ticks', () => {
  assert.equal(status({ activity: 999, seen: 999, viewers: 1, quiet: true }), 'idle', 'an idle repaint is not work');
  assert.equal(status({ activity: 999, seen: 999, viewers: 1, quiet: false }), 'busy', 'a changing screen is work');
  assert.equal(status({ quiet: true, screenWaiting: true }), 'waiting', 'questions still surface once quiet');
});

test('content clock advances only on visible change', () => {
  const first = trackContent(undefined, 'a\nb', 900, 1000);
  assert.equal(first.at, 900, 'first sight inherits activity');
  assert.equal(trackContent(first, 'a\nb', 900, 1000).at, 900, 'a repaint keeps the old time');
  assert.equal(trackContent(first, 'a\nc', 999, 1000).at, 1000, 'new text restarts the clock');
});

test('screen rules only apply to quiet windows', () => {
  assert.equal(status({ screenWaiting: true }), 'waiting');
  assert.equal(status({ activity: 999, screenWaiting: true }), 'busy');
});

test('silent tool commands remain busy while explicit waiting and completion win', () => {
  assert.equal(status({ toolRunning: true }), 'busy');
  assert.equal(status({ toolRunning: true, hook: { state: 'working', at: 900 } }), 'busy');
  assert.equal(status({ toolRunning: true, hook: { state: 'waiting', at: 900 } }), 'waiting');
  assert.equal(status({ toolRunning: true, hook: { state: 'done', at: 950 } }), 'attention');
  assert.equal(status({ toolRunning: true, screenWaiting: true }), 'waiting');
  assert.equal(status({ hook: { state: 'working', at: 999 } }), 'busy', 'fresh hooks count even before output');
});

test('tool detection follows the agent subtree and ignores persistent services', () => {
  const procs = new Map([
    [1, [{ pid: 2, ppid: 1, argv: ['claude'] }, { pid: 3, ppid: 1, argv: ['bash', '-c', 'sleep 60'] }]],
    [2, [{ pid: 4, ppid: 2, argv: ['node', 'mcp-server.js'] }]],
  ]);
  assert.equal(hasToolWork(procs, 2), false);
  procs.set(4, [{ pid: 5, ppid: 4, argv: ['/bin/bash', '-lc', 'sleep 60'] }]);
  assert.equal(hasToolWork(procs, 2), true);
});

test("a background task agy left running isn't a turn: its footer says it's at its prompt", () => {
  const procs = new Map([[1, [{ pid: 2, ppid: 1, argv: ['agy'] }]], [2, [{ pid: 3, ppid: 2, argv: ['bash', '-c', 'sleep infinity | node host.mjs'] }]]]);
  const footer = new RegExp(loadConfig().presets.find((p) => p.id === 'gemini')!.turnFooter!);
  assert.equal(turnToolWork(procs, 2, AGY_TASK_AT_PROMPT_NARROW, footer), false, 'stopped with Esc, on a phone');
  assert.equal(turnToolWork(procs, 2, AGY_TASK_AT_PROMPT, footer), false);
  assert.equal(turnToolWork(procs, 2, AGY_TURN_WITH_TASK_NARROW, footer), true, 'a turn running a command');
  // A permission prompt's footer says "esc to cancel" too; it reads as waiting before this.
  assert.equal(turnToolWork(procs, 2, AGY_COMMAND_NARROW, footer), true);
  // An agent without a footer to read (or with hooks) keeps counting every shell.
  assert.equal(turnToolWork(procs, 2, AGY_TASK_AT_PROMPT), true);
  assert.equal(turnToolWork(procs, 2, [], footer), true, "a screen that couldn't be read leaves it to the shells");
  assert.equal(turnToolWork(new Map([[1, [{ pid: 2, ppid: 1, argv: ['agy'] }]]]), 2, AGY_TURN_WITH_TASK_NARROW, footer), false, 'no shell, no tool');
});

// Pinned terminal rules (F18): each default pattern must keep matching what it was written for,
// and must not fire on ordinary output.
const rules = (id: string) => (loadConfig().presets.find((p) => p.id === id)?.waitingPatterns ?? []).map((s) => new RegExp(s, 'm'));

test('claude terminal rules', () => {
  const r = rules('claude');
  assert.ok(screenAsks(['Bash command', '  rm -rf build', 'Do you want to proceed?', '❯ 1. Yes', '  2. No'], r));
  assert.ok(screenAsks(['Do you want to make this edit to App.tsx?'], r));
  assert.ok(!screenAsks(['✳ Thinking…', '> '], r));
  assert.ok(!screenAsks(['I asked whether you want to proceed with the refactor.'], r));
});

test('codex terminal rules', () => {
  const r = rules('codex');
  assert.ok(screenAsks(['Would you like to run the following command?', '$ pnpm test'], r));
  assert.ok(!screenAsks(['• Ran pnpm test', '  └ 12 passed'], r));
});

test('muse terminal rules', () => {
  const r = rules('muse');
  assert.ok(
    screenAsks(
      [
        'Would you like to allow this network access? · from workflow-agent',
        '  network: api.github.com:443 https',
        '  1. Yes, proceed (y)',
        '> 2. Yes, don\'t ask again this session (p)  api.github.com:443 (https)',
        '  3. Always allow this network destination  api.github.com:443 (https)',
        '  4. No, and tell Muse Code what to do differently (esc)',
      ],
      r,
    ),
  );
  assert.ok(!screenAsks(['✳ Thinking…', '> '], r));
});

test('only the last screen lines count', () => {
  const lines = ['Do you want to proceed?', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)];
  assert.ok(!screenAsks(lines, rules('claude')));
});

test('adoption pairs a live window with its transcript, once', () => {
  const win = (o: Partial<WindowView>) => ({ agent: 'claude', harnessId: null, cwd: '/p', createdAt: 100, activity: 500, uid: 'u', model: null, ...o }) as WindowView;
  const adopted: string[] = [];
  const registry = { adopt: (uid: string, id: string) => adopted.push(`${uid}=${id}`) } as any;
  const windows = [win({ uid: 'a' }), win({ uid: 'b' }), win({ uid: 'c', agent: 'codex' })];
  adoptTranscripts(
    windows,
    [
      { harness: 'claude', harnessId: 'new', cwd: '/p', title: '', updatedAt: 400, file: '/p/new.jsonl' },
      { harness: 'claude', harnessId: 'old', cwd: '/p', title: '', updatedAt: 10, file: '/p/old.jsonl' },
    ],
    registry,
  );
  assert.deepEqual(adopted, ['a=new'], 'second window does not steal it; stale transcript is not adopted');
  assert.equal(windows[0].harnessId, 'new');
});

test("a window waiting for its own conversation id never takes a thread its agent spawned", () => {
  const adopted: string[] = [];
  const registry = { adopt: (uid: string, id: string) => adopted.push(`${uid}=${id}`), all: () => [] } as any;
  const windows = [{ agent: 'codex', harnessId: null, cwd: '/p', createdAt: 100, activity: 500, uid: 'w', model: null } as unknown as WindowView];
  const child = { harness: 'codex', harnessId: 'child', cwd: '/p', title: 'Map the routes', updatedAt: 450, birthAt: 120, file: '/s/child.jsonl', spawned: { parentId: 'root', rootId: 'root', depth: 1, kind: 'spawn' as const } };
  adoptTranscripts(windows, [child], registry);
  assert.deepEqual(adopted, []);
  adoptTranscripts(windows, [child, { harness: 'codex', harnessId: 'root', cwd: '/p', title: 'Refactor', updatedAt: 440, birthAt: 110, file: '/s/root.jsonl' }], registry);
  assert.deepEqual(adopted, ['w=root']);
});

test('fresh window does not adopt a transcript that ended before it started', () => {
  const win = (o: Partial<WindowView>) => ({ agent: 'muse', harnessId: null, cwd: '/p', createdAt: 1000, activity: 1000, uid: 'fresh', model: null, ...o }) as WindowView;
  const adopted: string[] = [];
  const registry = { adopt: (uid: string, id: string) => adopted.push(`${uid}=${id}`), all: () => [] } as any;
  const windows = [win({})];
  adoptTranscripts(windows, [{ harness: 'muse', harnessId: 'old', cwd: '/p', title: 'pwa probe', updatedAt: 990, file: '/old/session.jsonl' }], registry);
  assert.deepEqual(adopted, [], 'transcript touched before the window started is not its conversation');
  assert.equal(windows[0].harnessId, null);
});

test('adoption skips transcripts another record already owns', () => {
  const win = (o: Partial<WindowView>) => ({ agent: 'muse', harnessId: null, cwd: '/p', createdAt: 100, activity: 500, uid: 'fresh', model: null, ...o }) as WindowView;
  const adopted: string[] = [];
  const registry = {
    adopt: (uid: string, id: string) => adopted.push(`${uid}=${id}`),
    all: () => [{ id: 'ended1', harness: 'muse', harnessId: 'taken' }],
  } as any;
  const windows = [win({})];
  adoptTranscripts(
    windows,
    [{ harness: 'muse', harnessId: 'taken', cwd: '/p', title: 'ended session', updatedAt: 400, file: '/p/taken.jsonl' }],
    registry,
  );
  assert.deepEqual(adopted, [], 'an owned conversation id is never re-adopted by a new window');
  assert.equal(windows[0].harnessId, null);
});

test('novelty adoption binds by session identity, not recency', () => {
  const win = (o: Partial<WindowView>) => ({ agent: 'muse', harnessId: null, cwd: '/p', createdAt: 1000, activity: 1000, uid: 'n', model: null, ...o }) as WindowView;
  const adopted: string[] = [];
  const registry = {
    adopt: (uid: string, id: string) => adopted.push(`${uid}=${id}`),
    all: () => [],
    get: () => ({ meta: { 'ah.knownTranscripts': ['old'] } }),
  } as any;
  const windows = [win({})];
  adoptTranscripts(
    windows,
    [
      // Still being written by another process, newer than the window — but it
      // existed at launch, so it is not this session's transcript.
      { harness: 'muse', harnessId: 'old', cwd: '/p', title: 'other session', updatedAt: 2000, file: '/old/session.jsonl' },
      { harness: 'muse', harnessId: 'new', cwd: '/p', title: 'own session', updatedAt: 1005, file: '/new/session.jsonl' },
    ],
    registry,
  );
  assert.deepEqual(adopted, ['n=new'], 'known ids are never adopted, however recent');
  assert.equal(windows[0].harnessId, 'new');
});

test('a hungry window cannot steal a newer window conversation', () => {
  const win = (o: Partial<WindowView>) => ({ agent: 'muse', harnessId: null, cwd: '/p', createdAt: 1000, activity: 1000, uid: 'n', model: null, ...o }) as WindowView;
  const adopted: string[] = [];
  const registry = {
    adopt: (uid: string, id: string) => adopted.push(`${uid}=${id}`),
    all: () => [],
    get: () => ({ meta: { 'ah.knownTranscripts': [] } }),
  } as any;
  // Older window (its own transcript has no prompt yet, so both are novel to
  // it) must not grab the newest transcript, which belongs to the newer window.
  const windows = [win({ uid: 'old', createdAt: 1000 }), win({ uid: 'new', createdAt: 2000 })];
  adoptTranscripts(
    windows,
    [
      { harness: 'muse', harnessId: 'new-t', cwd: '/p', title: 'new work', updatedAt: 2010, birthAt: 2001, file: '/new/session.jsonl' },
      { harness: 'muse', harnessId: 'old-t', cwd: '/p', title: 'Muse session', updatedAt: 1005, birthAt: 1001, file: '/old/session.jsonl' },
    ],
    registry,
  );
  assert.deepEqual(adopted, ['old=old-t', 'new=new-t']);
  assert.equal(windows[0].harnessId, 'old-t');
  assert.equal(windows[1].harnessId, 'new-t');
});

test('novelty adoption waits when only known transcripts exist', () => {
  const win = (o: Partial<WindowView>) => ({ agent: 'muse', harnessId: null, cwd: '/p', createdAt: 1000, activity: 1000, uid: 'n', model: null, ...o }) as WindowView;
  const adopted: string[] = [];
  const registry = {
    adopt: (uid: string, id: string) => adopted.push(`${uid}=${id}`),
    all: () => [],
    get: () => ({ meta: { 'ah.knownTranscripts': ['old'] } }),
  } as any;
  const windows = [win({})];
  adoptTranscripts(windows, [{ harness: 'muse', harnessId: 'old', cwd: '/p', title: 'other', updatedAt: 2000, file: '/old/session.jsonl' }], registry);
  assert.deepEqual(adopted, [], 'no novel transcript yet: GUI waits instead of showing another session');
  assert.equal(windows[0].harnessId, null);
});

test('tmux output parses with raw (≥3.5) and escaped (3.4) separators', async () => {
  const { fields } = await import('./tmux.ts');
  assert.deepEqual(fields('agents\x1f@1\x1f/home/u'), ['agents', '@1', '/home/u']);
  assert.deepEqual(fields('agents\\037@1\\037/home/u'), ['agents', '@1', '/home/u']);
});

test("a shell's one-liner is the command it last ran, never its prompt", () => {
  const screen = ['demo master ? ❱ git status; ls -la', 'On branch master', 'index.js', 'demo master ? ❱'];
  assert.equal(shellDetail(screen, true), '$ git status; ls -la');
  // The prompt changed since (a new git state): first word and final symbol still match.
  assert.equal(shellDetail(['demo master ❱ touch a', 'demo master ? ❱'], true), '$ touch a');
  // Nothing typed in reach: show nothing rather than the prompt.
  assert.equal(shellDetail(['demo master ? ❱'], true), null);
  // Running something: its latest output.
  assert.equal(shellDetail(['building step 3'], false), 'building step 3');
  assert.equal(shellDetail([], true), null);
});

test('a shell is at its prompt when it holds the foreground and runs no script', () => {
  const procs = (root: { argv: string[]; fg?: boolean }) => new Map([[0, [{ pid: 10, ppid: 0, ...root }]]]);
  assert.equal(atShellPrompt('zsh', procs({ argv: ['-zsh'], fg: true }), 10, false), true);
  assert.equal(atShellPrompt('zsh', procs({ argv: ['-zsh'], fg: false }), 10, true), false, 'a command holds the foreground');
  assert.equal(atShellPrompt('bash', procs({ argv: ['bash', '-c', 'for i in 1 2; do sleep 1; done'], fg: true }), 10, true), false, 'a script is not a prompt');
  assert.equal(atShellPrompt('bash', procs({ argv: ['/bin/bash', '-lc', 'make'], fg: true }), 10, true), false);
  assert.equal(atShellPrompt('node', procs({ argv: ['node'], fg: true }), 10, true), false);
  assert.equal(atShellPrompt('bash', new Map(), 10, true), true, 'no process table: quiet means idle');
});

test("an agent's usage-limit notice reads as the limit and when it resets, until then", () => {
  const at = new Date(2026, 9, 12, 22, 30).getTime() / 1000; // 10:30pm
  const claude = ['● Working on it', "  ⎿  You've hit your session limit · resets 12am (Asia/Jerusalem)", '❯ '];
  assert.equal(screenLimit(claude, at, at + 60), 'Session limit · resets 12am');
  assert.equal(screenLimit(claude, at, at + 2 * 3600), null, 'past midnight it no longer holds');
  const codex = ["■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at 11:33 PM.", '› '];
  assert.equal(screenLimit(codex, at, at + 60), 'Usage limit · resets 11:33 PM');
  assert.equal(screenLimit(['all good'], at, at), null);
  assert.equal(resetTime('1:50am', at), new Date(2026, 9, 13, 1, 50).getTime() / 1000, 'the next 1:50am');
  assert.equal(resetTime('Oct 16, 7am', at), new Date(2026, 9, 16, 7, 0).getTime() / 1000);
  assert.equal(resetTime('soon', at), null);
});

test("agy's quota notice reads as the limit, its countdown as the time it resets, while it's the last thing agy said", () => {
  const at = new Date(2026, 10, 24, 8, 15, 20).getTime() / 1000;
  // As ah reads a screen: its non-empty lines.
  const screen = AGY_QUOTA_NARROW.filter((l) => l.trim());
  assert.equal(screenLimit(screen, at, at + 60), 'Quota reached · resets 9:24am', '8:15:20 + 1h7m49s, up to the minute: the latest notice, not the first');
  assert.equal(resetTime('9:24am', at), new Date(2026, 10, 24, 9, 24).getTime() / 1000);
  assert.equal(screenLimit(screen, at, at + 2 * 3600), null, 'past the reset it no longer holds');
  assert.match(agyQuota(screen) ?? '', /1h7m49s\. Error ID: .*1803$/, 'the notice is its own text, Error ID and all: a new one is seen anew');
  // A later turn under it: the notice scrolled up is over, whether agy is working or done.
  const said = screen.slice(0, -4);
  const box = screen.slice(-4); // rule, the empty prompt, rule, the footer
  const rule = box[0];
  const working = [...said, rule, '> Proceed', '● Explored 4 files (ctrl+o to expand)', '⠿ Reading file...', ...box];
  assert.equal(agyQuota(working), null);
  assert.equal(screenLimit(working, at, at + 60), null);
  assert.equal(screenLimit([...said, rule, '> Proceed', 'Done: the review is up.', ...box], at, at + 60), null);
  // A draft typed into the box doesn't hide it; days away carry the date.
  assert.equal(screenLimit([...said, rule, '> try again', rule, box[3]], at, at + 60), 'Quota reached · resets 9:24am');
  const days = screen.map((l) => l.replace('1h7m49s.', '2d3h.'));
  assert.equal(screenLimit(days, at, at + 60), 'Quota reached · resets Nov 26, 11:16am');
  assert.equal(resetTime('Nov 26, 11:16am', at), new Date(2026, 10, 26, 11, 16).getTime() / 1000);
});

test("agy's footer names its mode, but not Ask; YOLO, a launch flag, is not left by what the footer says", async () => {
  const { DEFAULT_PRESETS } = await import('./config.ts');
  const agy = DEFAULT_PRESETS.find((p) => p.id === 'gemini')!;
  const { detect, unnamed } = agy.modeCycle!;
  const footer = (mode: string) => ['> ', '─'.repeat(60), `? for shortcuts                       ${mode}Gemini 4 Neon · low`];
  assert.equal(footerMode(footer('auto · '), detect, unnamed), 'default');
  assert.equal(footerMode(footer('accept-edits · '), detect, unnamed), 'accept-edits');
  assert.equal(footerMode(footer('plan · '), detect, unnamed), 'plan');
  assert.equal(footerMode(footer(''), detect, unnamed), 'ask', 'a footer naming no mode is Ask');
  assert.equal(footerMode(footer(''), detect), null, 'without `unnamed`: not showing its mode');
  // No footer (a reply streaming, a picker up): no mode to read. Its prompt's hint names a mode in words, never "auto · ".
  assert.equal(footerMode(['> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)', 'esc to cancel'], detect, unnamed), null);
  // A phone's 49 columns: a footer that doesn't fit drops everything but "? for shortcuts",
  // and the empty prompt's hint is what still names the mode (agy 1.5.15's screens).
  const { prompt } = agy.modeCycle!;
  // ah captures with -J, which keeps the spaces the footer is padded with.
  const narrow = (hint: string) => ['  ⎿  Effort set to high', hint, '─'.repeat(49), `? for shortcuts${' '.repeat(34)}`];
  assert.equal(footerMode(narrow('> Accept-edits mode: file edits auto-approved...'), detect, unnamed), null, 'the footer alone says nothing: not Ask');
  assert.equal(footerMode(narrow('> Accept-edits mode: file edits auto-approved...'), detect, unnamed, prompt), 'accept-edits');
  assert.equal(footerMode(narrow('> Auto mode: edits & safe ...'), detect, unnamed, prompt), 'default');
  assert.equal(footerMode(narrow('> Plan mode: research & pl...'), detect, unnamed, prompt), 'plan');
  assert.equal(footerMode(narrow('>'), detect, unnamed, prompt), 'ask', "Ask's prompt has no hint");
  assert.equal(footerMode(narrow('> half a message'), detect, unnamed, prompt), null, 'a typed message hides the hint');
  assert.equal(footerMode(['> Plan mode: research & plan only', '  ⎿  ok', ...narrow('> half a message')], detect, unnamed, prompt), 'plan', 'nor is a sent message read as the hint… unless it says exactly that');
  // Where the footer fits, it wins over the hint.
  assert.equal(footerMode(['> Plan mode: research & plan only', '─'.repeat(60), '? for shortcuts                       auto · Gemini 4 Neon · low'], detect, unnamed, prompt), 'default');
  assert.equal(flagOnlyMode(agy, 'yolo'), true);
  assert.equal(flagOnlyMode(agy, 'plan'), false);
  assert.equal(flagOnlyMode(agy, undefined), false);
  // Claude's bypass mode shows in its footer: cycling can leave it.
  assert.equal(flagOnlyMode(DEFAULT_PRESETS.find((p) => p.id === 'claude')!, 'dangerous'), false);
  // A command it asks about waits for you, however long the command.
  const rules = agy.waitingPatterns!.map((r) => new RegExp(r, 'm'));
  const asking = ['Requesting permission for:', ...Array.from({ length: 8 }, (_, i) => `   line ${i} of a long command`), 'Run this command?', '> 1. Yes, run command', '  4. No, cancel', '  ↑/↓ Navigate · tab Amend', 'esc to cancel'];
  assert.equal(screenAsks(asking, rules), true);
  assert.equal(screenAsks(footer('auto · '), rules), false);
  // On a phone its rows wrap, and the question sits above the last 12 lines.
  assert.equal(screenAsks(AGY_COMMAND_NARROW, rules), true);
  assert.equal(screenAsks(AGY_RSYNC_NARROW.filter((l) => l.trim()), rules), true, 'rows agy wrapped short of the window');
  // A question in the conversation above, with no picker under it, is still no prompt.
  assert.equal(screenAsks(['Run this command?', ...Array.from({ length: 14 }, (_, i) => `line ${i}`)], rules), false);
});

test('footerMode reads the mode from the footer, not from the conversation above it', () => {
  const detect = loadConfig().presets.find((p) => p.id === 'claude')!.modeCycle!.detect;
  const box = ['─'.repeat(40), '❯ ', '─'.repeat(40)];
  assert.equal(footerMode([...box, '  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents'], detect), 'accept-edits');
  assert.equal(footerMode([...box, '  ⏸ manual mode on · ? for shortcuts'], detect), 'default');
  const talk = ['● I turned plan mode on earlier.', ...Array(10).fill('  more prose')];
  assert.equal(footerMode([...talk, ...box, '  ⏵⏵ auto mode on (shift+tab to cycle)'], detect), 'auto');
  assert.equal(footerMode([...talk, ...box], detect), null, 'no footer: unknown, not the mode the prose names');
});

test('an agent is told by its executable or the script its interpreter runs', () => {
  assert.deepEqual(processNames(['claude']), ['claude']);
  assert.deepEqual(processNames(['python', '/p/hermes']), ['python', 'hermes']);
  // Gemini CLI 0.64: flags before the bundled script, which carries an extension.
  assert.deepEqual(processNames(['/m/node/26.8.1/bin/node', '--max-old-space-size=14440', '/m/gemini/latest/bundle/gemini.js']), ['node', 'gemini']);
  assert.deepEqual(processNames(['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.mjs']), ['node', 'cli']);
  // Only an interpreter's script loses its extension: an editor opening gemini.js is not Gemini.
  assert.deepEqual(processNames(['vim', 'gemini.js']), ['vim', 'gemini.js']);
});

test('a folder that becomes a repository (git init) is seen as one within seconds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-repo-'));
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    assert.equal(repoInfo(dir), null);
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    assert.equal(repoInfo(dir), null, 'remembered a moment');
    mock.timers.tick(6_000);
    assert.equal(repoInfo(dir)?.branch, 'main', 'asked again');
    rmSync(join(dir, '.git'), { recursive: true });
    assert.equal(repoInfo(dir), null, 'a removed repository goes at once');
  } finally {
    mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a shell's running command stays working between its lines; at the prompt it goes idle as usual", () => {
  // idleAfter 4: a command printing every 6s is still working at 6s quiet, not at 13s.
  assert.equal(commandBusy(false, 106, 100, 4), true);
  assert.equal(commandBusy(false, 113, 100, 4), false);
  assert.equal(commandBusy(true, 106, 100, 4), false, 'at its prompt: no hold');
  assert.equal(status({ activity: 900, toolRunning: commandBusy(false, 1000, 990, 4) }), 'busy');
});

test('a waiting prompt has a stable fingerprint that changes with what it asks', async () => {
  const { askFingerprint } = await import('./sessions.ts');
  const ask = { kind: 'command' as const, text: 'Bash command\n  rm -rf build', options: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }] };
  assert.equal(askFingerprint(null), null);
  assert.match(askFingerprint(ask)!, /^[0-9a-f]{16}$/);
  assert.equal(askFingerprint({ ...ask }), askFingerprint(ask), 'same prompt, same id');
  assert.notEqual(askFingerprint({ ...ask, text: 'Bash command\n  rm -rf /' }), askFingerprint(ask), 'another command');
  assert.notEqual(askFingerprint({ ...ask, options: [{ key: '1', label: 'Yes' }] }), askFingerprint(ask), 'other choices');
  assert.notEqual(askFingerprint({ ...ask, kind: 'tool' }), askFingerprint(ask));
});

// Grok 1.0.92 asks before a command (plan mode, or any it isn't allowed to run alone) with radio
// rows over a "2/4:select" footer, and its turn timer runs on meanwhile: ah read it as working
// for as long as it waited, with nothing to answer it from (found running reviews on ah).
test('grok terminal rules: a command to approve, its own questions and its plan, under its running timer', () => {
  const r = rules('grok');
  const screen = readFileSync(new URL('./fixtures/grok/approval-plan.txt', import.meta.url), 'utf8').split('\n').filter((l) => l.trim());
  assert.ok(screenAsks(screen, r));
  const picker = parsePicker(screen.slice(-40));
  assert.deepEqual(picker?.options, [
    { key: '2', label: 'Yes, proceed' },
    { key: '3', label: 'No, reject (type to add feedback)' },
    { key: '4', label: 'Never allow: git log' },
  ]);
  assert.match(picker!.context, /^Ordered commits and changed files\ngit log --oneline main\.\.HEAD/);
  // Its own question (ask_user): the row that opens a text box isn't offered.
  const asked = readFileSync(new URL('./fixtures/grok/question.txt', import.meta.url), 'utf8').split('\n').filter((l) => l.trim());
  assert.ok(screenAsks(asked, r));
  const question = parsePicker(asked.slice(-40));
  assert.equal(question?.context, "I've finished the adversarial review. How should I deliver it?");
  assert.deepEqual(question?.options, [{ key: '1', label: 'Write findings into the plan file and present for approval', description: '(Recommended) Saves the ranked defect list to plan.md and exits plan mode so' }]);
  // Its plan, for approval: the keys that act at once.
  const plan = readFileSync(new URL('./fixtures/grok/plan-approval.txt', import.meta.url), 'utf8').split('\n').filter((l) => l.trim());
  assert.ok(screenAsks(plan, r));
  assert.deepEqual(parsePicker(plan.slice(-40))?.options, [{ key: 'a', label: 'Approve' }, { key: 'q', label: 'Quit plan' }]);
  // An option's description beside it, as Grok sets short ones.
  const beside = ['  ┃  Which color do you prefer?', '  ┃', '  ┃  1 (●) Red   Prefer the color red', '  ┃  2 (○) Blue  Prefer the color blue', '  ┃  z (○) Type your answer here', '  ┃', '  Tab:next answer  │  Esc:scrollback  │  Shift+x:dismiss'];
  assert.ok(screenAsks(beside, r));
  assert.deepEqual(parsePicker(beside)?.options, [
    { key: '1', label: 'Red', description: 'Prefer the color red' },
    { key: '2', label: 'Blue', description: 'Prefer the color blue' },
  ]);
  // At its prompt, and at work, it asks nothing.
  assert.ok(!screenAsks(['  ╭──────╮', '  │ ❯    │', '  ╰── Grok 4.5 (low) · plan ─╯', '  Shift+Tab:mode  │  Ctrl+x:shortcuts'], r));
  assert.ok(!screenAsks(['   ◆ Reading files… 12s          12s ⇣3.0k [↓][stop]', '  ┃  ›  Read server/core.ts'], r));
  assert.ok(!screenAsks(['     ❯ What does "Tab:next answer" do in Grok?'], r));
  assert.equal(parsePicker(['  ┃  ›  Read server/core.ts', '  Shift+Tab:mode  │  Ctrl+x:shortcuts']), null);
});
