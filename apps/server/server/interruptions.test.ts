import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { causeOf, Interruptions, INTERRUPTED, lastStep, noteFor, stepOf, type Interrupted, type InterruptionDeps } from './interruptions.ts';
import type { QueueItem } from './queue.ts';
import type { SessionRecord } from './registry.ts';

const dir = mkdtempSync(join(tmpdir(), 'ah-interrupt-'));
const alive = { pid: 100, gone: false, empty: false };

test('what cut a session off: the server, a restart, a closed window, or nothing (it just ended)', () => {
  const base = { startup: false, last: { pid: 100, at: 1000 }, server: alive, bootAt: 10, lastActivityAt: 900 };
  assert.equal(causeOf({ ...base, server: { pid: 0, gone: true, empty: false }, lastStatus: 'idle' }), 'tmux_server', 'no server: every session in it, idle too');
  assert.equal(causeOf({ ...base, server: { pid: 200, gone: false, empty: true }, lastStatus: 'attention' }), 'tmux_server', 'a new server replaced it');
  assert.equal(causeOf({ ...base, lastStatus: 'busy' }), 'window', 'its window closed mid-turn');
  assert.equal(causeOf({ ...base, lastStatus: 'waiting' }), 'window');
  assert.equal(causeOf({ ...base, lastStatus: 'idle' }), null, 'an idle window closed: someone closed it');
  // Found gone when ah starts.
  const start = { ...base, startup: true };
  assert.equal(causeOf({ ...start, bootAt: 1500, server: { pid: 300, gone: false, empty: true }, lastStatus: 'idle' }), 'host_restart', 'booted since ah last ticked');
  assert.equal(causeOf({ ...start, server: { pid: 300, gone: false, empty: false }, lastStatus: 'idle' }), 'tmux_server', 'another server than ah last saw');
  assert.equal(causeOf({ ...start, lastStatus: 'idle' }), null, 'same server, closed while ah was away');
  assert.equal(causeOf({ ...start, last: null, bootAt: 950, lastStatus: 'idle' }), 'host_restart', 'no record of the server: its last activity predates the boot');
  assert.equal(causeOf({ ...start, last: null, lastStatus: 'busy' }), 'window');
});

test('the note says what happened, when, and the last step; it asks to check before going on', () => {
  const i: Interrupted = { cause: 'tmux_server', at: 1_794_663_485, lastSeenAt: 1_794_663_484, incident: 'x', lastStatus: 'busy', midTurn: true };
  const note = noteFor(i, 'you called Bash ("npm test")');
  assert.match(note, /^\[ah\] This session was interrupted at \w{3} \w{3} \d\d \d{4} \d\d:\d\d:\d\d GMT[+-]\d{4}: the tmux server it ran in stopped while you were working/);
  assert.match(note, /The last step recorded: you called Bash \("npm test"\)\./);
  assert.match(note, /Check the state of whatever you were in the middle of/);
  assert.ok(!note.includes('\n'), 'one line');
  const away = noteFor({ ...i, cause: 'host_restart', lastSeenAt: i.at - 600, lastStatus: 'waiting' }, null);
  assert.match(away, /interrupted between .+ and .+: the host restarted while you were waiting for an answer/);
  assert.match(away, /If you still need the answer, ask again\.$/);
  assert.ok(!away.includes('last step'));
});

test('the last step: its last tool call with the argument that says what it did, else its words', async () => {
  const call = (name: string, args: Record<string, unknown>) => ({ seq: 1, id: '1', role: 'assistant' as const, step: 'llm_call' as const, at: 0, parts: [{ type: 'tool_call' as const, call: { id: 'c', name, args } }] });
  assert.equal(stepOf(call('Bash', { command: 'npm test\n  --watch', description: 'run' })), 'you called Bash ("npm test --watch")');
  assert.equal(stepOf(call('Edit', { file_path: '/a/b.ts', old_string: 'x' })), 'you called Edit ("/a/b.ts")');
  assert.equal(stepOf(call('Think', {})), 'you called Think');
  assert.equal(stepOf({ ...call('x', {}), parts: [{ type: 'text', text: 'Now I\'ll run the "migration" `step`' }] }), 'you wrote "Now I\'ll run the \'migration\' \'step\'"');
  assert.equal(stepOf({ ...call('x', {}), parts: [{ type: 'text', text: 'y'.repeat(400) }] })!.length, 'you wrote ""'.length + 160);

  const file = join(dir, 'claude.jsonl');
  const line = (content: unknown[], type = 'assistant') => JSON.stringify({ type, uuid: Math.random().toString(36), timestamp: new Date().toISOString(), message: { role: type, content } });
  writeFileSync(file, [line([{ type: 'text', text: 'hi' }], 'user'), line([{ type: 'text', text: 'Running the tests.' }]), line([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]), line([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], 'user'), '{"cut'].join('\n'));
  assert.equal(await lastStep(file, 'claude'), 'you called Bash ("npm test")');
  assert.equal(await lastStep(file, 'nope'), null);
  assert.equal(await lastStep(join(dir, 'missing.jsonl'), 'claude'), null);
});

type Bed = { records: Map<string, SessionRecord>; queues: Map<string, QueueItem[]>; resumed: string[]; settled: string[]; alerts: Array<{ title: string; body: string }>; server: { pid: number; gone: boolean; empty: boolean }; deps: InterruptionDeps };

function bed(file = join(dir, `rt-${Math.random()}.json`), bootAt = 10): Bed {
  const b = { records: new Map(), queues: new Map(), resumed: [], settled: [], alerts: [], server: { ...alive } } as unknown as Bed;
  b.deps = {
    record: (uid) => b.records.get(uid),
    records: () => [...b.records.values()],
    setMeta: (uid, key, value) => {
      const r = b.records.get(uid)!;
      if (value === undefined) delete r.meta[key];
      else r.meta[key] = value;
    },
    server: () => b.server,
    bootAt: () => bootAt,
    file,
    queue: {
      items: (uid) => [...(b.queues.get(uid) ?? [])],
      first: (uid, item) => b.queues.set(uid, [item, ...(b.queues.get(uid) ?? []).filter((q) => q.id !== item.id)]),
      clear: (uid, id) => b.queues.set(uid, (b.queues.get(uid) ?? []).filter((q) => q.id !== id)),
    },
    resume: async (uid) => {
      b.resumed.push(uid);
      const r = b.records.get(uid)!;
      r.lifecycle = 'starting';
      delete r.meta[INTERRUPTED];
      return { uid, windowId: `@${uid}`, resumed: true };
    },
    transcript: async () => null,
    settle: async (uid) => void b.settled.push(uid),
    alert: (p) => b.alerts.push(p),
    changed: () => {},
  };
  return b;
}

const rec = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({ id, host: 'h', harness: 'claude', harnessId: `conv-${id}`, cwd: '/p', title: id.toUpperCase(), status: 'idle', lifecycle: 'live', pendingResume: false, createdAt: 1, lastActivityAt: 1, exitCode: null, meta: {}, ...extra }) as SessionRecord;

/** What registry.reconcile does for a session found gone. */
function end(b: Bed, x: Interruptions, r: SessionRecord) {
  const last = r.status;
  r.lifecycle = 'ended';
  r.status = 'ended';
  x.ended(r, last);
}

test('a tmux server stopping interrupts every open session at once: one incident, one alert', async () => {
  const b = bed();
  const x = new Interruptions(b.deps);
  x.tick(); // ah's first look: the server it runs with
  for (const [id, status] of [['a', 'busy'], ['b', 'idle'], ['c', 'waiting'], ['d', 'busy']] as const) b.records.set(id, rec(id, { status }));
  b.records.get('d')!.meta['ah.endedBy'] = 'you';
  b.records.set('sh', rec('sh', { harness: 'shell', harnessId: undefined }));
  b.queues.set('b', [{ id: 'q1', text: 'your prompt', enter: true, at: 1 }]);
  b.server = { pid: 0, gone: true, empty: false };
  for (const r of [...b.records.values()]) end(b, x, r);
  x.tick();
  const list = x.list();
  assert.deepEqual(list.map((s) => [s.uid, s.cause, s.midTurn]), [['a', 'tmux_server', true], ['c', 'tmux_server', true], ['b', 'tmux_server', false]].sort((p, q) => Number(q[2]) - Number(p[2])), 'mid-turn first; ended by you and shells are not interrupted');
  assert.equal(new Set(list.map((s) => s.incident)).size, 1);
  assert.equal(list.find((s) => s.uid === 'b')!.queued, 1);
  assert.deepEqual(x.state(), { count: 3, midTurn: 2, incidents: [{ id: list[0].incident, cause: 'tmux_server', at: list[0].at, count: 3, midTurn: 2 }] });
  assert.equal(b.alerts.length, 1);
  assert.deepEqual(b.alerts[0], { title: '3 sessions were interrupted', body: 'The tmux server stopped; 2 were working. Restore them in ah.', tag: `interrupted-${list[0].incident}`, url: '/#interrupted' });
  x.tick();
  assert.equal(b.alerts.length, 1, 'told once');
});

test('restoring: mid-turn ones first, told before their queued prompts; idle ones just resumed; once', async () => {
  const b = bed();
  const x = new Interruptions(b.deps);
  x.tick();
  b.records.set('a', rec('a', { status: 'busy' }));
  b.records.set('b', rec('b', { status: 'idle' }));
  b.queues.set('a', [{ id: 'q1', text: 'your prompt', enter: true, at: 1 }]);
  b.server = { pid: 0, gone: true, empty: false };
  for (const r of [...b.records.values()]) end(b, x, r);
  x.tick();
  const out = await x.restoreAll({});
  assert.deepEqual(b.resumed, ['a', 'b'], 'mid-turn first');
  assert.deepEqual(out.restored.map((r) => [r.uid, r.noted]), [['a', true], ['b', false]]);
  assert.deepEqual(b.queues.get('a')!.map((q) => q.id.startsWith('interrupted-') ? 'note' : q.id), ['note', 'q1'], 'the note goes before your prompt; your prompt is kept');
  assert.match(b.queues.get('a')![0].text, /^\[ah\] This session was interrupted/);
  assert.equal(b.queues.get('b'), undefined, 'nothing typed into a session that had finished');
  assert.deepEqual(b.settled, ['a', 'b'], 'recovery stops waiting on them');
  assert.deepEqual(x.list(), []);
  assert.deepEqual(await x.restoreAll({}), { restored: [], failed: [] }, 'again: nothing to do');
  await assert.rejects(x.restore('nope'), { code: 'not_found' });
  b.records.set('e', rec('e', { lifecycle: 'ended', status: 'ended' }));
  await assert.rejects(x.restore('e'), { code: 'not_interrupted', status: 409 });
});

test('a closed window is an interruption only mid-turn; dismissing forgets it and its note', async () => {
  const b = bed();
  const x = new Interruptions(b.deps);
  x.tick();
  b.records.set('a', rec('a', { status: 'busy' }));
  b.records.set('b', rec('b', { status: 'attention' }));
  for (const r of [...b.records.values()]) end(b, x, r);
  x.tick();
  assert.deepEqual(x.list().map((s) => [s.uid, s.cause]), [['a', 'window']]);
  assert.equal(b.alerts[0].body, 'Its window was closed; 1 was working. Restore it in ah.');
  const i = x.list()[0];
  b.queues.set('a', [{ id: `interrupted-${i.at}`, text: 'note', enter: true, at: 1 }, { id: 'q1', text: 'mine', enter: true, at: 1 }]);
  assert.equal(x.dismiss({ uids: ['a'] }), 1);
  assert.deepEqual(b.queues.get('a')!.map((q) => q.id), ['q1'], 'your prompt stays');
  assert.deepEqual(x.list(), []);
  assert.equal(b.records.get('a')!.meta[INTERRUPTED], undefined);
});

test('after ah restarts: a new tmux server or a reboot is told apart from sessions you closed', async () => {
  const file = join(dir, 'rt-restart.json');
  const before = bed(file);
  new Interruptions(before.deps).tick();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).pid, 100, 'ah remembers its server');
  const at = JSON.parse(readFileSync(file, 'utf8')).at;

  // Same server: a session closed while ah was away isn't an interruption (unless mid-turn).
  const same = bed(file);
  const x1 = new Interruptions(same.deps);
  same.records.set('a', rec('a', { status: 'idle' }));
  end(same, x1, same.records.get('a')!);
  assert.deepEqual(x1.list(), []);

  // A new server: everything that was open in the old one.
  const fresh = bed(file);
  fresh.server = { pid: 555, gone: false, empty: true };
  const x2 = new Interruptions(fresh.deps);
  fresh.records.set('a', rec('a', { status: 'idle', lastActivityAt: at - 50 }));
  end(fresh, x2, fresh.records.get('a')!);
  assert.deepEqual(x2.list().map((s) => [s.cause, s.lastSeenAt]), [['tmux_server', at]], 'last seen when ah last ticked');

  // The host booted since ah last ticked.
  const boot = bed(file, at + 30);
  boot.server = { pid: 556, gone: false, empty: true };
  const x3 = new Interruptions(boot.deps);
  boot.records.set('a', rec('a', { status: 'busy' }));
  end(boot, x3, boot.records.get('a')!);
  x3.tick();
  assert.equal(x3.list()[0].cause, 'host_restart');
  assert.equal(boot.alerts[0].body, 'The host restarted; 1 was working. Restore it in ah.');
});
