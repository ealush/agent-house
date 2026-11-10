import { test, mock } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { computeStatus, footerMode, screenAsks, adoptTranscripts, hasToolWork, atShellPrompt, processNames, resetTime, screenLimit, shellDetail, trackContent, repoInfo, commandBusy, type StatusInput, type WindowView } from './sessions.ts';
import { loadConfig } from './config.ts';

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
