import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'ah-push-'));
const { Push, askLine } = await import('./push.ts');

const win = (uid: string, status: string) => ({ uid, id: '@1', name: uid, project: 'p', agent: 'claude', command: 'claude', status }) as any;

/** Observes at fixed moments (epoch seconds), as the host's ticker would. */
function clock(t: any, start = 1_700_000_000) {
  t.mock.timers.enable({ apis: ['Date'], now: start * 1000 });
  return (s: number) => t.mock.timers.setTime((start + s) * 1000);
}

test('notifies on transitions only, never on startup, with per-event filtering', (t) => {
  const at = clock(t);
  const push = new Push();
  const sent: string[] = [];
  (push as any).send = (event: string, p: { title: string }) => sent.push(`${event}:${p.title}`);

  push.observe([win('a', 'waiting'), win('b', 'busy')]); // first pass: learn, don't alert
  assert.deepEqual(sent, []);

  push.observe([win('a', 'waiting'), win('b', 'attention')]); // b's turn ended…
  assert.deepEqual(sent, [], 'not yet: it may go straight back to work');
  at(31);
  push.observe([win('a', 'waiting'), win('b', 'attention')]); // …and stayed ended
  assert.deepEqual(sent, ['done:b finished']);

  push.observe([win('a', 'busy'), win('b', 'idle')]);
  push.observe([win('a', 'waiting'), win('b', 'idle')]); // a asks again
  assert.deepEqual(sent, ['done:b finished', 'waiting:a needs you']);

  push.observe([win('a', 'busy')]);
  push.observe([win('a', 'waiting')]); // within cooldown: suppressed
  assert.equal(sent.length, 2);
});

test('a turn that pauses and goes back to work is not "finished", however often it does', (t) => {
  const at = clock(t);
  const push = new Push();
  const sent: string[] = [];
  (push as any).send = (event: string) => sent.push(event);
  push.observe([win('a', 'busy')]);
  for (let s = 0; s < 120; s += 4) {
    at(s);
    push.observe([win('a', 'attention')]);
    at(s + 2);
    push.observe([win('a', 'busy')]);
  }
  assert.deepEqual(sent, [], 'thinking, a breath, thinking again: one long turn');
  // Its subagents still at work: not done either, however long the main agent rests.
  const resting = { ...win('a', 'attention'), subagents: { total: 1, active: 1, completed: 0, failed: 0, rev: '1' } };
  at(200);
  push.observe([resting]);
  at(400);
  push.observe([resting]);
  assert.deepEqual(sent, []);
  // They're done and nothing moves: finished, 30 seconds from when they were last at work.
  at(410);
  push.observe([win('a', 'attention')]);
  at(429);
  push.observe([win('a', 'attention')]);
  assert.deepEqual(sent, []);
  at(430);
  push.observe([win('a', 'attention')]);
  assert.deepEqual(sent, ['done']);
});

test('"finished" at most once every few minutes per session: the last one waits, it is not lost', (t) => {
  const at = clock(t);
  const push = new Push();
  const sent: string[] = [];
  (push as any).send = (event: string, p: { title: string }) => sent.push(`${event}:${p.title}`);
  const turn = (start: number) => {
    at(start);
    push.observe([win('a', 'busy')]);
    at(start + 10);
    push.observe([win('a', 'attention')]);
    at(start + 45);
    push.observe([win('a', 'attention')]);
  };
  push.observe([win('a', 'idle')]);
  turn(0);
  assert.deepEqual(sent, ['done:a finished']);
  turn(60);
  assert.deepEqual(sent, ['done:a finished'], 'a second one 60 seconds on waits');
  at(170);
  push.observe([win('a', 'attention')]);
  assert.equal(sent.length, 1);
  at(225);
  push.observe([win('a', 'attention')]);
  assert.deepEqual(sent, ['done:a finished', 'done:a finished'], 'told once its three minutes are up');
  // Looked at in the meantime: nothing left to tell.
  turn(300);
  at(330);
  push.observe([win('a', 'idle')]);
  at(600);
  push.observe([win('a', 'idle')]);
  assert.equal(sent.length, 2);
});

test('idle → attention (output while away, not a finished turn) is not a "done" alert', () => {
  const push = new Push();
  const sent: string[] = [];
  (push as any).send = (event: string) => sent.push(event);
  push.observe([win('c', 'idle')]);
  push.observe([win('c', 'attention')]);
  assert.deepEqual(sent, []);
});

test('rejects malformed subscriptions', () => {
  const push = new Push();
  assert.throws(() => push.subscribe({ endpoint: 'http://insecure', keys: { p256dh: 'x', auth: 'y' } }, { waiting: true, done: false }, ''));
  assert.throws(() => push.subscribe({} as any, { waiting: true, done: false }, ''));
});

test('alerts name the agent, and a turn that stopped on its limit says so', (t) => {
  const at = clock(t);
  const push = new Push();
  const sent: Array<{ title: string; body: string }> = [];
  (push as any).send = (_event: string, p: { title: string; body: string }) => sent.push(p);
  const name = (id: string) => (id === 'claude' ? 'Claude Code' : id);
  push.observe([win('d', 'busy'), win('e', 'busy')], name);
  push.observe([win('d', 'attention'), { ...win('e', 'attention'), limit: 'Session limit · resets 12am' }], name);
  at(30);
  push.observe([win('d', 'attention'), { ...win('e', 'attention'), limit: 'Session limit · resets 12am' }], name);
  assert.deepEqual(sent, [
    { title: 'd finished', body: 'p · Claude Code', tag: 'd', url: '/#d', badge: '0' },
    { title: 'e hit its usage limit', body: 'p · Session limit · resets 12am', tag: 'e', url: '/#e', badge: '0' },
  ]);
});

test('alerts use the session title and say what a waiting session asks', () => {
  const push = new Push();
  const sent: Array<{ title: string; body: string }> = [];
  (push as any).send = (_event: string, p: { title: string; body: string }) => sent.push(p);
  const w = { ...win('f', 'busy'), name: 'claude', title: 'Fix Safari login flash' };
  push.observe([w]);
  push.observe([{ ...w, status: 'waiting', ask: { kind: 'command', text: 'Bash command\n  pnpm test --filter auth\n  Run the auth test suite\nDo you want to proceed?' } }]);
  assert.equal(sent[0].title, 'Fix Safari login flash needs you');
  assert.equal(sent[0].body, 'p · Wants to run pnpm test --filter auth');
});

test('alerts say what was said last: the answer when it finished, not the tool it ran', (t) => {
  const at = clock(t);
  const push = new Push();
  const sent: Array<{ title: string; body: string }> = [];
  (push as any).send = (_event: string, p: { title: string; body: string }) => sent.push(p);
  const name = (id: string) => (id === 'claude' ? 'Claude Code' : id);
  const w = { ...win('g', 'busy'), title: 'Left rail sidebar design', detail: '$ cd /tmp/claude-1000/x' };
  const done = { ...w, status: 'attention', reply: { role: 'assistant', text: 'Fixed in the app:\nan edited message goes back.', at: 1 } };
  push.observe([w], name);
  push.observe([done], name);
  at(30);
  push.observe([done], name);
  assert.equal(sent[0].title, 'Left rail sidebar design finished');
  assert.equal(sent[0].body, 'p · Fixed in the app: an edited message goes back.');
});

test('askLine reads a question and a hook-reported command', () => {
  assert.equal(askLine({ kind: 'command', text: 'pnpm test' } as any), 'Wants to run pnpm test');
  assert.equal(askLine({ kind: 'choice', text: 'How should old names be handled?' } as any), 'Asks: How should old names be handled?');
  assert.equal(askLine(null), '');
});

test('supervised worker alerts are muted while supervisor is live and fail open when supervisor exits or escalates', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  try {
    const push = new Push();
    const sent: Array<{ event: string; title: string }> = [];
    (push as any).send = (event: string, p: { title: string }) => sent.push({ event, title: p.title });

    const cos = win('cos-1', 'idle');
    const worker = { ...win('w-1', 'busy'), supervision: { role: 'worker', managedBy: 'cos-1', escalateAfterSeconds: 60 } };

    // First pass primes state.
    push.observe([cos, worker]);
    assert.deepEqual(sent, []);

    // Worker enters waiting while supervisor is live → muted.
    push.observe([cos, { ...worker, status: 'waiting' }]);
    assert.deepEqual(sent, []);

    // Still muted at 30s.
    t.mock.timers.setTime(1_700_000_030_000);
    push.observe([cos, { ...worker, status: 'waiting' }]);
    assert.deepEqual(sent, []);

    // Past escalateAfterSeconds (60s) → fails open to user.
    t.mock.timers.setTime(1_700_000_065_000);
    push.observe([cos, { ...worker, status: 'waiting' }]);
    assert.deepEqual(sent, [{ event: 'waiting', title: 'w-1 needs you' }]);

    // Another worker transitions to waiting, then its supervisor exits → fails open immediately.
    const w2 = { ...win('w-2', 'busy'), supervision: { role: 'worker', managedBy: 'cos-1', escalateAfterSeconds: 300 } };
    push.observe([cos, { ...worker, status: 'idle' }, w2]);
    t.mock.timers.setTime(1_700_000_070_000);
    push.observe([cos, { ...worker, status: 'idle' }, { ...w2, status: 'waiting' }]);
    assert.equal(sent.length, 1);

    // Supervisor disappears from live windows → immediate fail-open.
    t.mock.timers.setTime(1_700_000_075_000);
    push.observe([{ ...worker, status: 'idle' }, { ...w2, status: 'waiting' }]);
    assert.deepEqual(sent, [
      { event: 'waiting', title: 'w-1 needs you' },
      { event: 'waiting', title: 'w-2 needs you' },
    ]);
  } finally {
    t.mock.timers.reset();
  }
});
