import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMigrated, getDb } from './db.ts';
import { importLegacyJson } from './migrate.ts';
import { Registry } from './registry.ts';
import { PromptStore } from './prompts.ts';
import { SideChatStore } from './sidechat.ts';

async function freshDb() {
  const path = join(tmpdir(), `ah-migrate-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await ensureMigrated(path);
  return { path, db: getDb(path) };
}

async function legacyDir() {
  const dir = await mkdtemp(join(tmpdir(), 'ah-legacy-'));
  await writeFile(
    join(dir, 'sessions.json'),
    JSON.stringify([
      {
        id: 'abc123', host: 'h', harness: 'claude', cwd: '/tmp', title: 'vest',
        status: 'idle', lifecycle: 'live', createdAt: 100, lastActivityAt: 200,
        exitCode: null, tmux: { session: 'ah-abc123', windowId: '@1' }, meta: { 'ah.queue': [] },
      },
      // v1 row: uid/name instead of id/title.
      { uid: 'old9', host: 'h', harness: 'shell', cwd: '/x', name: 'oldie', createdAt: 50, lastAliveAt: 60 },
    ]),
  );
  await writeFile(join(dir, 'prompts.json'), JSON.stringify([{ text: 'first', at: 10 }, { text: 'second', at: 20 }]));
  await writeFile(
    join(dir, 'sidechat.json'),
    JSON.stringify({
      subscriptions: [{ id: 'sub1', name: 'o', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' }],
      defaultId: 'sub1',
      chats: { abc123: [{ role: 'user', text: 'hi', at: 30 }, { role: 'assistant', text: 'yo', at: 31 }] },
    }),
  );
  return dir;
}

test('importLegacyJson: imports sessions, prompts, subscriptions, chats; idempotent', async () => {
  const { path, db } = await freshDb();
  const dir = await legacyDir();
  assert.deepEqual(await importLegacyJson(db, dir), { sessions: 2, prompts: 2, subscriptions: 1, chatMessages: 2, settings: 1 });

  // Sessions visible through the Registry, v1 row normalized.
  const reg = new Registry(path);
  await reg.ready();
  assert.equal(reg.get('abc123')?.title, 'vest');
  assert.deepEqual(reg.get('abc123')?.tmux, { session: 'ah-abc123', windowId: '@1' });
  assert.equal(reg.get('old9')?.title, 'oldie');

  // Prompts newest-first through the store ('first'-headed the legacy file).
  assert.deepEqual(await new PromptStore(path).load(), [{ text: 'first', at: 10 }, { text: 'second', at: 20 }]);

  // Subscriptions + chat history through the side-chat store (keys never leak).
  const side = new SideChatStore(path);
  assert.deepEqual((await side.list()).map((s) => [s.id, s.isDefault]), [['sub1', true]]);
  assert.deepEqual((await side.history('abc123')).map((m) => [m.role, m.text]), [['user', 'hi'], ['assistant', 'yo']]);
  const chats = await side.listChats();
  assert.equal(chats.length, 1);
  assert.deepEqual([chats[0].uid, chats[0].title, chats[0].count], ['abc123', 'vest', 2]);

  // Second pass imports nothing.
  assert.deepEqual(await importLegacyJson(db, dir), { sessions: 0, prompts: 0, subscriptions: 0, chatMessages: 0, settings: 0 });
});

test('registry: writes survive across instances', async () => {
  const { path } = await freshDb();
  const a = new Registry(path);
  await a.ready();
  a.starting('w1', { harness: 'claude', cwd: '/tmp', title: 'one', tmux: { session: 's', windowId: '@1' } });
  await a.settled();
  const b = new Registry(path);
  await b.ready();
  assert.equal(b.get('w1')?.title, 'one');
  assert.equal(b.get('w1')?.lifecycle, 'starting');
});

test('prompts: save/load round-trips newest-first', async () => {
  const { path } = await freshDb();
  const store = new PromptStore(path);
  await store.save([{ text: 'a', at: 1 }, { text: 'b', at: 2 }]);
  assert.deepEqual(await new PromptStore(path).load(), [{ text: 'b', at: 2 }, { text: 'a', at: 1 }]);
  await store.clear();
  assert.deepEqual(await new PromptStore(path).load(), []);
});
