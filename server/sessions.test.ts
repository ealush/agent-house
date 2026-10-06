import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStatus, screenAsks, adoptTranscripts, hasToolWork, type StatusInput, type WindowView } from './sessions.ts';
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
