import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from './registry.ts';
import { ensureMigrated } from './db.ts';
import { QueueManager, boxHolds, type QueueItem, type QueueRuntime } from './queue.ts';
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
    clearInput: async () => true,
    press: async () => {},
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
  const state = { landed: false, box: '', still: true, writing: false, cleared: 0 };
  const ready = setup(async (...args: unknown[]) => void typed.push(args[1] as string), {
    transcriptMark: async () => ({ adapter: 'claude', file: '/t.jsonl', size: 10, seq: 0, at: Date.now() }),
    landed: async () => state.landed,
    inputBox: async () => state.box,
    still: async () => state.still,
    writing: async () => state.writing,
    clearInput: async () => {
      state.cleared++;
      state.box = '';
      return true;
    },
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

test('a delivery never seen is typed again once, then shown as not sent: never a loop', async () => {
  // An agent that couldn't resume its conversation started another; ah reads the old one,
  // where nothing it types ever shows (Muse, on a verification host: typed seven times).
  const { typed, ready } = watched();
  const { q, win } = await ready;
  await q.deliverDue([win()]);
  await q.confirmDeliveries([win()]);
  await q.deliverDue([win()]);
  assert.deepEqual(typed, ['say a', 'say a'], 'once more');
  await q.confirmDeliveries([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b'], 'not queued a third time');
  assert.deepEqual(q.unsent('u1').map((i) => i.id), ['a'], 'shown as not sent');
  await q.deliverDue([win()]);
  assert.deepEqual(typed, ['say a', 'say a', 'say b'], 'the next one goes on');
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

test('never typed twice: someone else’s text in the box, or an agent still animating, is left alone', async () => {
  const { state, ready } = watched();
  const { q, win } = await ready;
  await q.deliverDue([win()]);
  state.still = false;
  await q.confirmDeliveries([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b'], 'a turn its status never showed holds it');
  state.still = true;
  state.box = 'say a, and also what I typed myself';
  await q.confirmDeliveries([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b'], 'more than ah typed: not ah’s to clear');
  assert.equal(state.cleared, 0);
  assert.deepEqual(q.unsent('u1').map((i) => i.id), ['a'], 'but said: not sent');
  // And no longer watched: settled for good.
  state.box = '';
  await q.confirmDeliveries([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b']);
});

// The owner's report (2026-11-22): a message to Gemini sat typed in its box, unsent, and
// ah, which can't read Antigravity's box, said nothing.
test("a box ah can't read gets one more Enter; still not seen, the message shows as not sent", async () => {
  let pressed = 0;
  const { typed, state, ready } = watched({ inputBox: async () => null, press: async () => void pressed++ });
  const { q, win } = await ready;
  await q.deliverDue([win()]);
  await q.confirmDeliveries([win()]);
  assert.equal(pressed, 1, 'one more Enter');
  assert.deepEqual(q.unsent('u1'), [], 'not given up on yet');
  await q.deliverDue([win()]);
  assert.deepEqual(typed, ['say a'], 'the next waits behind it');
  const w = win();
  await q.confirmDeliveries([w]);
  assert.equal(pressed, 1, 'only once');
  assert.deepEqual(q.unsent('u1').map((i) => [i.id, i.unsent]), [['a', true]]);
  assert.equal(w.unsent, 1);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b'], 'not queued: never typed again on its own');
  await q.deliverDue([win()]);
  assert.deepEqual(typed, ['say a', 'say b'], 'and the queue goes on behind it');
});

// pi over ah's bridge takes messages over its socket, never through its box: an Enter there
// could only take whatever dialog pi has open (Neon's review of the stack).
test("no Enter into pi over ah's bridge: a message it never shows is not sent", async () => {
  let pressed = 0;
  const { ready } = watched({ inputBox: async () => null, press: async () => void pressed++ });
  const { q, win } = await ready;
  const pi = () => ({ ...win(), agent: 'pi', statusSource: 'hook' });
  await q.deliverDue([pi()]);
  await q.confirmDeliveries([pi()]);
  assert.equal(pressed, 0);
  assert.deepEqual(q.unsent('u1').map((i) => i.id), ['a']);
});

test('the Enter took: the message is seen and nothing shows as not sent', async () => {
  const { state, ready } = watched({ inputBox: async () => null, press: async () => void (state.landed = true) });
  const { q, win } = await ready;
  await q.deliverDue([win()]);
  await q.confirmDeliveries([win()]);
  await q.confirmDeliveries([win()]);
  assert.deepEqual(q.unsent('u1'), []);
  assert.equal(q.watching('u1'), false);
});

test('one shown as not sent: sent by hand it goes; sent again it goes back first in line; removed it’s let go', async () => {
  const { state, ready } = watched({ inputBox: async () => null });
  const { q, win } = await ready;
  const notSent = async () => {
    await q.deliverDue([win()]);
    await q.confirmDeliveries([win()]);
    await q.confirmDeliveries([win()]);
  };
  await notSent();
  assert.deepEqual(q.unsent('u1').map((i) => i.id), ['a']);
  state.landed = true; // Enter pressed in the terminal
  const w = win();
  await q.confirmDeliveries([w]);
  assert.deepEqual(q.unsent('u1'), []);
  assert.equal(w.unsent, 0);
  state.landed = false;
  await notSent();
  assert.deepEqual(q.unsent('u1').map((i) => i.id), ['b']);
  assert.equal(await q.sendAgain('u1', 'b'), 'queued');
  assert.deepEqual([q.unsent('u1'), q.items('u1').map((i) => i.id)], [[], ['b']]);
  assert.equal(await q.sendAgain('u1', 'b'), null, 'only one shown as not sent');
  await notSent();
  q.clear('u1', 'b');
  assert.deepEqual([q.unsent('u1'), q.items('u1')], [[], []]);
});

// The owner's report (2026-11-24): a message Gemini was answering showed as not sent, and
// Send Again typed it in a second time.
test('sent again, one its conversation has by now is let go, not typed twice', async () => {
  const { typed, state, ready } = watched({ inputBox: async () => null });
  const { q, win } = await ready;
  await q.deliverDue([win()]);
  await q.confirmDeliveries([win()]);
  await q.confirmDeliveries([win()]);
  assert.deepEqual(q.unsent('u1').map((i) => i.id), ['a']);
  state.landed = true; // it went in after all, and the agent is still answering it
  assert.equal(await q.sendAgain('u1', 'a'), 'landed');
  assert.deepEqual([q.unsent('u1'), q.items('u1').map((i) => i.id)], [[], ['b']], 'gone, not queued again');
  assert.deepEqual(typed, ['say a']);
});

// The owner's report: the queue emptied, and the follow-up sat typed in Claude Code's
// box, waiting for an Enter that never took.
test('a follow-up left in the box unsent is taken back out and queued first again, a few times at most', async () => {
  const { typed, state, ready } = watched();
  const { q, win } = await ready;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await q.deliverDue([win()]);
    assert.equal(typed.length, attempt);
    state.box = 'say a'; // the Enter didn't take
    const w = win();
    await q.confirmDeliveries([w]);
    assert.equal(state.box, '', 'the box is emptied, not left typed-but-unsent');
    assert.deepEqual(q.items('u1').map((i) => i.id), ['a', 'b'], 'still owed, first in line');
    assert.equal(w.queued, 2, 'the session shows it queued again');
  }
  // A fourth time stuck: left in the box, in plain sight, rather than typed forever.
  await q.deliverDue([win()]);
  state.box = 'say a';
  await q.confirmDeliveries([win()]);
  assert.equal(state.box, 'say a');
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b']);
  assert.equal(state.cleared, 3);
  assert.deepEqual(typed, ['say a', 'say a', 'say a', 'say a']);
});

test('a box that couldn’t be emptied keeps the follow-up where it is, never typed on top of', async () => {
  const { typed, state, ready } = watched({ clearInput: async () => false });
  const { q, win } = await ready;
  await q.deliverDue([win()]);
  state.box = 'say a';
  await q.confirmDeliveries([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b']);
  assert.deepEqual(typed, ['say a']);
});

test('the box holds what ah typed however Claude Code shows it', () => {
  assert.ok(boxHolds('say a', 'say a'));
  assert.ok(boxHolds('Why does the session keep resta rting?', 'Why does the session keep restarting?'), 'wrapped mid-word');
  assert.ok(boxHolds('[Pasted text #1 +12 lines]', 'a\nlong\npaste'));
  assert.ok(boxHolds('[Image #1] what is this?', '/home/me/.cache/ah/uploads/x.png what is this?'));
  assert.ok(boxHolds('[Image #1] [Image #2] look', '~/a.png ~/b.jpg look'));
  assert.ok(!boxHolds('say a and more', 'say a'));
  assert.ok(!boxHolds('something else', 'say a'));
  assert.ok(!boxHolds('[Image #1]', ''));
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

test('a delivered follow-up its sender named is remembered by id, in the record; others aren’t', async () => {
  const { q, win } = await setup(async () => {});
  for (const id of ['a', 'b']) q.take('u1', id);
  q.enqueue('u1', { id: 'job-run-1', text: 'go', enter: true, at: 0, named: true });
  q.enqueue('u1', { id: 'r4nd0m01', text: 'hi', enter: true, at: 0 });
  q.enqueue('u1', { id: 'job-run-2', text: 'more', enter: true, at: 0, named: true });
  await q.deliverDue([win()]);
  await q.deliverDue([win()]);
  assert.equal(q.wasDelivered('u1', 'job-run-1'), true);
  assert.equal(q.wasDelivered('u1', 'r4nd0m01'), false, 'an id ah made up takes no room in the ledger');
  assert.equal(q.wasDelivered('u1', 'job-run-2'), false, 'still queued');
});
