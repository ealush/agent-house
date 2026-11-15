import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QueueItem } from '../web/api.ts';
import { placeBack, placeOf, putBack } from '../web/requeue.ts';

const item = (id: string, text = id): QueueItem => ({ id, text, enter: true, at: 1 });

/** A queue host: the server queues a send at the end, and moves one on request. */
function host(ids: string[]) {
  let items = ids.map((id) => item(id));
  const moves: Array<{ id: string; to: number }> = [];
  return {
    moves,
    ids: () => items.map((q) => q.id),
    queue: async () => [...items],
    moveQueued: async (_uid: string, id: string, to: number) => {
      moves.push({ id, to });
      const at = items.findIndex((q) => q.id === id);
      const [moved] = items.splice(at, 1);
      items.splice(Math.min(to, items.length), 0, moved);
      return [...items];
    },
    enqueue: (id: string) => void (items = [...items, item(id)]),
    remove: (id: string) => void (items = items.filter((q) => q.id !== id)),
  };
}

test("a queued message's place is the one after it; the last one has none", () => {
  const items = ['a', 'b', 'c'].map((id) => item(id));
  assert.equal(placeOf(items, 'a'), 'b');
  assert.equal(placeOf(items, 'b'), 'c');
  assert.equal(placeOf(items, 'c'), undefined, 'the end is its place already');
  assert.equal(placeOf(items, 'gone'), undefined);
});

test('a message edited out of the middle and queued again goes back in its place', async () => {
  const h = host(['a', 'b', 'c']);
  const before = placeOf(await h.queue(), 'b');
  h.remove('b');
  // Reworded and sent while the agent works: the server queues it at the end.
  h.enqueue('n1');
  await putBack(h, 'u1', 'n1', before!);
  assert.deepEqual(h.ids(), ['a', 'n1', 'c']);
  assert.deepEqual(h.moves, [{ id: 'n1', to: 1 }]);
});

test('queued again after the one it went before was sent, it stays where the server put it', async () => {
  const h = host(['a', 'c']);
  h.remove('c');
  h.enqueue('n1');
  await putBack(h, 'u1', 'n1', 'c');
  assert.deepEqual(h.ids(), ['a', 'n1']);
  assert.deepEqual(h.moves, []);
});

test('already in front of its place, nothing moves', () => {
  const items = ['a', 'n1', 'c'].map((id) => item(id));
  assert.equal(placeBack(items, 'n1', 'c'), null);
  assert.equal(placeBack(items, 'gone', 'c'), null);
  assert.equal(placeBack([item('c'), item('n1')], 'n1', 'c'), 0);
});

test('a queue that fails to answer leaves the message where it is', async () => {
  const failing = { queue: async () => { throw new Error('offline'); }, moveQueued: async () => [] };
  await putBack(failing, 'u1', 'n1', 'c');
});
