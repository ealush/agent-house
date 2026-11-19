import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from './registry.ts';
import { ensureMigrated } from './db.ts';
import { writeFileSync, appendFileSync, statSync } from 'node:fs';
import { QueueManager, needleFor, transcriptHas, type QueueItem, type QueueRuntime } from './queue.ts';
import { PasteError } from './tmux.ts';

async function setup(paste: (...args: unknown[]) => Promise<void>, rt: Partial<QueueRuntime> = {}) {
  const path = join(tmpdir(), `ah-queue-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await ensureMigrated(path);
  const registry = new Registry(path);
  registry.starting('u1', { harness: 'claude', harnessId: 'c1', cwd: '/tmp', title: 't', tmux: { session: 's', windowId: '@1' } });
  const q = new QueueManager(registry, {
    withInput: (_uid, fn) => fn(),
    justSent: () => false,
    markSent: () => {},
    captureTurnStart: async () => {},
    paste,
    applyLaunchChange: () => {},
    transcriptMark: async () => null,
    landed: async () => false,
    writing: async () => false,
    inputBox: async () => '',
    still: async () => true,
    ...rt,
  }, { confirmGraceMs: 0 });
  const item = (id: string): QueueItem => ({ id, text: `say ${id}`, enter: true, at: 0 });
  q.enqueue('u1', item('a'));
  q.enqueue('u1', item('b'));
  const win = () => ({ uid: 'u1', id: '@1', status: 'idle', queued: q.items('u1').length, createdAt: 0 }) as any;
  return { q, win };
}

test('a follow-up whose paste typed nothing stays first in line', async () => {
  const { q, win } = await setup(async () => {
    throw new PasteError('tmux went away', false);
  });
  await q.deliverDue([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['a', 'b']);
});

test('once any text landed, the follow-up counts as delivered (never typed twice)', async () => {
  const { q, win } = await setup(async () => {
    throw new PasteError('Enter failed', true);
  });
  await q.deliverDue([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b']);
});

test('a delivered follow-up leaves the queue', async () => {
  const typed: string[] = [];
  const { q, win } = await setup(async () => {
    typed.push('x');
  });
  await q.deliverDue([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b']);
  assert.equal(typed.length, 1);
});

test('a taken item that fails before anything is typed goes back first in line', async () => {
  const { q } = await setup(async () => {});
  // send-now takes the item out before typing; an early failure (the agent
  // would not stop, the window went away, nothing reached it) must put the
  // follow-up back first — never lost, never duplicated.
  const taken = q.take('u1', 'b');
  assert.ok(taken);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['a']);
  q.requeue('u1', taken.next);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b', 'a']);
  assert.equal(q.items('u1')[0].text, 'say b');
});

test('a queued item moves to a new position; the rest keep their order', async () => {
  const { q } = await setup(async () => {});
  q.enqueue('u1', { id: 'c', text: 'say c', enter: true, at: 0 });
  assert.deepEqual(q.move('u1', 'c', 0)?.map((i) => i.id), ['c', 'a', 'b']);
  assert.deepEqual(q.move('u1', 'c', 99)?.map((i) => i.id), ['a', 'b', 'c'], 'past the end clamps to last');
  assert.deepEqual(q.move('u1', 'a', 1)?.map((i) => i.id), ['b', 'a', 'c']);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b', 'a', 'c'], 'persisted');
  assert.equal(q.move('u1', 'gone', 0), null, 'an item already sent is not there to move');
});

test('the next delivery takes whatever was moved to the front', async () => {
  const typed: string[] = [];
  const { q, win } = await setup(async (...args: unknown[]) => {
    typed.push(args[1] as string);
  });
  q.move('u1', 'b', 0);
  await q.deliverDue([win()]);
  assert.deepEqual(typed, ['say b']);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['a']);
});

// A follow-up typed into an agent that had started a turn of its own waits in the
// agent's input queue, and an interrupt throws it away: ah watches for it in the
// transcript, and puts it back when the agent settles without it.
function watched(rt: Partial<QueueRuntime> = {}) {
  const typed: string[] = [];
  const state = { landed: false, box: '', still: true, writing: false };
  const ready = setup(async (...args: unknown[]) => void typed.push(args[1] as string), {
    transcriptMark: async () => ({ file: '/t.jsonl', size: 10 }),
    landed: async () => state.landed,
    inputBox: async () => state.box,
    still: async () => state.still,
    writing: async () => state.writing,
    ...rt,
  });
  return { typed, state, ready };
}

test('a delivery the agent never took goes back first in line once it settles', async () => {
  const { typed, ready } = watched();
  const { q, win } = await ready;
  await q.deliverDue([win()]);
  assert.deepEqual(typed, ['say a']);
  await q.confirmDeliveries([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['a', 'b']);
  await q.deliverDue([win()]);
  assert.deepEqual(typed, ['say a', 'say a'], 'typed again, in order');
});

test('a delivery seen in the transcript is done, and the next one follows', async () => {
  const { typed, state, ready } = watched();
  const { q, win } = await ready;
  await q.deliverDue([win()]);
  // Not confirmed yet: the next waits rather than overtaking it.
  await q.deliverDue([win()]);
  assert.deepEqual(typed, ['say a']);
  state.landed = true;
  await q.confirmDeliveries([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b']);
  await q.deliverDue([win()]);
  assert.deepEqual(typed, ['say a', 'say b']);
});

test('never typed twice: text still in the box, or an agent still animating, is left alone', async () => {
  const { state, ready } = watched();
  const { q, win } = await ready;
  await q.deliverDue([win()]);
  state.still = false;
  await q.confirmDeliveries([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b'], 'a turn its status never showed holds it');
  state.still = true;
  state.box = 'say a';
  await q.confirmDeliveries([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b'], 'still in the input box: in plain sight');
  // And no longer watched: settled for good.
  state.box = '';
  await q.confirmDeliveries([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b']);
});

test('a busy session is not judged; one whose transcript is being written gets nothing typed', async () => {
  const { typed, state, ready } = watched();
  const { q, win } = await ready;
  state.writing = true;
  await q.deliverDue([win()]);
  assert.deepEqual(typed, [], 'a turn of its own is starting');
  state.writing = false;
  await q.deliverDue([win()]);
  await q.confirmDeliveries([{ ...win(), status: 'busy' }]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b']);
});

test("send now's recovery puts an unseen delivery back first; a seen one stays delivered", async () => {
  const { state, ready } = watched();
  const { q, win } = await ready;
  await q.deliverDue([win()]);
  const back = await q.recover('u1');
  assert.equal(back?.id, 'a');
  assert.deepEqual(q.items('u1').map((i) => i.id), ['a', 'b']);
  await q.deliverDue([win()]);
  state.landed = true;
  assert.equal(await q.recover('u1'), null);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b']);
});

test('slash commands are not watched (they answer on screen)', async () => {
  const { ready } = watched();
  const { q, win } = await ready;
  q.clear('u1');
  q.enqueue('u1', { id: 'm', text: '/model opus', enter: true, at: 0 });
  q.enqueue('u1', { id: 'b', text: 'say b', enter: true, at: 0 });
  await q.deliverDue([win()]);
  assert.equal(await q.recover('u1'), null);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b']);
});

test("a delivery is found by its first line, as the transcript's JSON spells it, after the mark only", async () => {
  const file = join(tmpdir(), `ah-queue-transcript-${process.pid}.jsonl`);
  const said = 'The workspaces 1-9 isn’t "very" useful\nsecond line';
  writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'before' } }) + '\n');
  const mark = { file, size: statSync(file).size };
  assert.equal(await transcriptHas(mark, said), false, 'nothing after the mark');
  appendFileSync(file, JSON.stringify({ type: 'user', message: { content: said } }) + '\n');
  assert.equal(await transcriptHas(mark, said), true);
  assert.equal(await transcriptHas(mark, 'before'), false, 'what came before the mark is not it');
  assert.equal(await transcriptHas({ file, size: 1 << 30 }, said), true, 'a rewritten file: never typed twice');
});

test('a pasted screenshot path is no way to find a prompt: Claude Code swaps it for [Image #1]', () => {
  const text = '/home/me/.cache/ah/uploads/a-paste.png /home/me/.cache/ah/uploads/b-paste.png We gotta be able to collapse the queue';
  assert.equal(needleFor(text), 'We gotta be able to collapse the queue');
  assert.equal(needleFor('first\nthe "longest" line of the prompt'), 'the \\"longest\\" line of the prompt');
  assert.equal(needleFor('/home/me/shot.png'), null, 'only a path: nothing to tell it by');
});

test('a follow-up stays queued (on disk) through the turn snapshot: a restart then can’t lose it', async () => {
  const during: string[][] = [];
  let registry: Registry | undefined;
  const { q, win } = await setup(async () => {}, {
    captureTurnStart: async () => {
      during.push(q.items('u1').map((i) => i.id));
      during.push(((registry!.get('u1')?.meta['ah.queue'] as QueueItem[]) ?? []).map((i) => i.id));
    },
  });
  registry = (q as unknown as { registry: Registry }).registry;
  await q.deliverDue([win()]);
  assert.deepEqual(during, [['a', 'b'], ['a', 'b']], 'still first in line, in memory and in the record, while the snapshot runs');
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b'], 'then typed and gone');
});

test('the delivered-ids ledger keeps the newest, once each', async () => {
  const { withDelivered, DELIVERED_KEEP } = await import('./queue.ts');
  assert.deepEqual(withDelivered([], 'a'), ['a']);
  assert.deepEqual(withDelivered(['a', 'b'], 'a'), ['b', 'a'], 'asked again: newest, not twice');
  const full = Array.from({ length: DELIVERED_KEEP }, (_, i) => `m${i}`);
  const next = withDelivered(full, 'new');
  assert.equal(next.length, DELIVERED_KEEP);
  assert.equal(next[0], 'm1', 'the oldest goes');
  assert.equal(next.at(-1), 'new');
});

test('a delivered follow-up is remembered by id, in the record', async () => {
  const { q, win } = await setup(async () => {});
  await q.deliverDue([win()]);
  assert.equal(q.wasDelivered('u1', 'a'), true);
  assert.equal(q.wasDelivered('u1', 'b'), false, 'still queued');
});
