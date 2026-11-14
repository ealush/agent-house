import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'ah-push-'));
const { Push, askLine } = await import('./push.ts');

const win = (uid: string, status: string) => ({ uid, id: '@1', name: uid, project: 'p', agent: 'claude', command: 'claude', status }) as any;

test('notifies on transitions only, never on startup, with per-event filtering', () => {
  const push = new Push();
  const sent: string[] = [];
  (push as any).send = (event: string, p: { title: string }) => sent.push(`${event}:${p.title}`);

  push.observe([win('a', 'waiting'), win('b', 'busy')]); // first pass: learn, don't alert
  assert.deepEqual(sent, []);

  push.observe([win('a', 'waiting'), win('b', 'attention')]); // b finished
  assert.deepEqual(sent, ['done:b finished']);

  push.observe([win('a', 'busy'), win('b', 'idle')]);
  push.observe([win('a', 'waiting'), win('b', 'idle')]); // a asks again
  assert.deepEqual(sent, ['done:b finished', 'waiting:a needs you']);

  push.observe([win('a', 'busy')]);
  push.observe([win('a', 'waiting')]); // within cooldown: suppressed
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

test('alerts name the agent, and a turn that stopped on its limit says so', () => {
  const push = new Push();
  const sent: Array<{ title: string; body: string }> = [];
  (push as any).send = (_event: string, p: { title: string; body: string }) => sent.push(p);
  const name = (id: string) => (id === 'claude' ? 'Claude Code' : id);
  push.observe([win('d', 'busy'), win('e', 'busy')], name);
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

test('alerts say what was said last: the answer when it finished, not the tool it ran', () => {
  const push = new Push();
  const sent: Array<{ title: string; body: string }> = [];
  (push as any).send = (_event: string, p: { title: string; body: string }) => sent.push(p);
  const name = (id: string) => (id === 'claude' ? 'Claude Code' : id);
  const w = { ...win('g', 'busy'), title: 'Left rail sidebar design', detail: '$ cd /tmp/claude-1000/x' };
  push.observe([w], name);
  push.observe([{ ...w, status: 'attention', reply: { role: 'assistant', text: 'Fixed in the app:\nan edited message goes back.', at: 1 } }], name);
  assert.equal(sent[0].title, 'Left rail sidebar design finished');
  assert.equal(sent[0].body, 'p · Fixed in the app: an edited message goes back.');
});

test('askLine reads a question and a hook-reported command', () => {
  assert.equal(askLine({ kind: 'command', text: 'pnpm test' } as any), 'Wants to run pnpm test');
  assert.equal(askLine({ kind: 'choice', text: 'How should old names be handled?' } as any), 'Asks: How should old names be handled?');
  assert.equal(askLine(null), '');
});
