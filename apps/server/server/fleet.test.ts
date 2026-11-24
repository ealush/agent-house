import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMigrated, getDb } from './db.ts';
import { FleetError, MailboxStore } from './fleet/mailbox.ts';
import { TaskStore } from './fleet/tasks.ts';

async function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ah-fleet-'));
  const path = join(dir, 'ah.db');
  await ensureMigrated(path);
  return getDb(path);
}

test('MailboxStore: send, list (direct + broadcast + unread + thread), ack, delete and validation', async () => {
  const db = await tempDb();
  const mail = new MailboxStore(db);

  const m1 = await mail.send({
    fromUid: 'cos-1',
    toUid: 'w-1',
    threadId: 'th-1',
    kind: 'directive',
    subject: 'Run migrations',
    body: 'Please verify Prisma migrations',
    meta: { priority: 1 },
  });
  assert.match(m1.id, /^mb-[0-9a-f]{8}$/);
  assert.equal(m1.ackedAt, null);
  assert.deepEqual(m1.meta, { priority: 1 });

  const bcast = await mail.send({
    fromUid: 'cos-1',
    toUid: '*',
    kind: 'message',
    subject: 'Freeze',
    body: 'Hold merges for 10m',
  });

  // Worker inbox includes direct mail AND broadcasts by default.
  const inbox = await mail.list({ toUid: 'w-1', unread: true });
  assert.equal(inbox.length, 2);
  assert.deepEqual(new Set(inbox.map((m) => m.id)), new Set([m1.id, bcast.id]));

  // Thread filter isolates the thread.
  const thread = await mail.list({ threadId: 'th-1' });
  assert.equal(thread.length, 1);
  assert.equal(thread[0].id, m1.id);

  // Ack removes it from unread inbox, stays in full inbox.
  const acked = await mail.ack(m1.id);
  assert.ok(acked.readAt && acked.ackedAt);
  assert.equal((await mail.list({ toUid: 'w-1', unread: true })).length, 1);
  assert.equal((await mail.list({ toUid: 'w-1', unread: false })).length, 2);

  // Delete removes permanently; missing id throws 404 FleetError.
  await mail.remove(m1.id);
  await assert.rejects(() => mail.get(m1.id), (e: unknown) => e instanceof FleetError && e.status === 404);

  // Validation rejects bad inputs.
  await assert.rejects(() => mail.send({ toUid: 'bad recipient!', body: 'hi' }), FleetError);
  await assert.rejects(() => mail.send({ toUid: 'w-1', kind: 'bogus', body: 'hi' }), FleetError);
  await assert.rejects(() => mail.send({ toUid: 'w-1', body: '   ' }), FleetError);

  // Sibling-group broadcast reaches siblings (not sender itself, not other groups).
  const sib = await mail.send({ fromUid: 'w-1', toUid: 'siblings:cos-1', kind: 'message', subject: 'Heads up', body: 'Rebasing auth' });
  const w2Inbox = await mail.list({ toUid: 'w-2', siblingGroup: 'siblings:cos-1', unread: true });
  assert.ok(w2Inbox.some((m) => m.id === sib.id), 'sibling receives sibling broadcast');
  const w1Inbox = await mail.list({ toUid: 'w-1', siblingGroup: 'siblings:cos-1', unread: true });
  assert.ok(!w1Inbox.some((m) => m.id === sib.id), 'sender does not echo its own sibling broadcast');
  const foreignInbox = await mail.list({ toUid: 'w-9', siblingGroup: 'siblings:cos-2', unread: true });
  assert.ok(!foreignInbox.some((m) => m.id === sib.id), 'other team does not receive sibling broadcast');

  // Per-recipient broadcast ack: w-2 acking sibling broadcast leaves it unread for w-3!
  await mail.ack(sib.id, 'w-2');
  const w2After = await mail.list({ toUid: 'w-2', siblingGroup: 'siblings:cos-1', unread: true });
  const w3After = await mail.list({ toUid: 'w-3', siblingGroup: 'siblings:cos-1', unread: true });
  assert.ok(!w2After.some((m) => m.id === sib.id), 'w-2 sees broadcast as acked');
  assert.ok(w3After.some((m) => m.id === sib.id), 'w-3 still sees broadcast as unread');

  // Rekey transfers inbox and sibling-group broadcasts when Chief relaunches.
  await mail.rekey('cos-1', 'cos-new');
  const rekeyedSib = await mail.get(sib.id);
  assert.equal(rekeyedSib.toUid, 'siblings:cos-new');
});

test('TaskStore: create, list filters, priority ordering, update with verification record, delete and validation', async () => {
  const db = await tempDb();
  const tasks = new TaskStore(db);

  const t1 = await tasks.create({
    title: 'Fix login race',
    description: 'Ensure cookie refresh is atomic',
    priority: 1,
    ownerUid: 'cos-1',
    assignedUid: 'w-1',
    space: 'auth',
    verifyCmd: 'pnpm test --filter auth',
  });
  assert.match(t1.id, /^tk-[0-9a-f]{8}$/);
  assert.equal(t1.status, 'todo');
  assert.equal(t1.priority, 1);

  const t2 = await tasks.create({
    title: 'Write release notes',
    priority: 0,
    ownerUid: 'cos-1',
    dependsOn: [t1.id],
    space: 'docs',
  });

  // Ordered by priority ascending (P0 before P1).
  const all = await tasks.list();
  assert.deepEqual(all.map((t) => t.id), [t2.id, t1.id]);

  // Filtered by space / assignedUid.
  assert.deepEqual((await tasks.list({ assignedUid: 'w-1' })).map((t) => t.id), [t1.id]);
  assert.deepEqual((await tasks.list({ space: 'docs' })).map((t) => t.id), [t2.id]);

  // Update status, verification result, and unassign.
  const updated = await tasks.update(t1.id, {
    status: 'done',
    assignedUid: null,
    result: 'Merged in #42',
    lastVerify: { at: 1700000000, command: 'pnpm test --filter auth', exitCode: 0, ok: true, output: 'pass' },
  });
  assert.equal(updated.status, 'done');
  assert.equal(updated.assignedUid, null);
  assert.equal(updated.lastVerify?.ok, true);
  assert.equal(updated.result, 'Merged in #42');

  // Delete and 404 check.
  await tasks.remove(t2.id);
  await assert.rejects(() => tasks.get(t2.id), (e: unknown) => e instanceof FleetError && e.status === 404);

  // Validation rejects bad priority, status, dependsOn.
  await assert.rejects(() => tasks.create({ title: '', priority: 1 }), FleetError);
  await assert.rejects(() => tasks.create({ title: 'x', priority: 9 }), FleetError);
  await assert.rejects(() => tasks.create({ title: 'x', status: 'flying' }), FleetError);
  await assert.rejects(() => tasks.create({ title: 'x', dependsOn: ['not-a-task-id'] }), FleetError);

  // Rekey transfers task ownership/assignment when Chief relaunches.
  const t3 = await tasks.create({ title: 'Follow up', ownerUid: 'cos-old', assignedUid: 'cos-old', space: 'Launch' });
  await tasks.rekey('cos-old', 'cos-new');
  const moved = await tasks.get(t3.id);
  assert.equal(moved.ownerUid, 'cos-new');
  assert.equal(moved.assignedUid, 'cos-new');
});
