import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SideChatStore, changeContext, parseStructured, type ChatContext } from './sidechat.ts';
import { getDb, ensureMigrated } from './db.ts';

const file = () => join(tmpdir(), `ah-sidechat-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);

async function freshStore(dbPath = file()) {
  await ensureMigrated(dbPath);
  return { store: new SideChatStore(dbPath), path: dbPath };
}
const ctx: ChatContext = { title: 'vest', session: 'agents', branch: 'gui-support', pr: 12, diff: 'diff --git a.ts\n+hi' };

async function withFetch(fn: (seen: { url: unknown; init: unknown }[]) => Response, run: () => Promise<void>) {
  const real = globalThis.fetch;
  const seen: { url: unknown; init: unknown }[] = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    seen.push({ url, init });
    return fn(seen);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
}

const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });

async function subscribed(dbPath?: string) {
  const { store: s, path } = await freshStore(dbPath);
  const info = await s.put({ name: ' work ', baseUrl: 'https://api.example.com/v1/', model: ' model ', apiKey: 'key' });
  return { store: s, id: info.id, path };
}

test('subscriptions: trimmed, redacted, first is default, persisted', async () => {
  const { store, id, path } = await subscribed();
  const [listed] = await store.list();
  assert.equal(listed.name, 'work');
  assert.equal(listed.baseUrl, 'https://api.example.com/v1');
  assert.equal(listed.model, 'model');
  assert.equal(listed.hasKey, true);
  assert.equal(listed.isDefault, true);
  assert.ok(!('apiKey' in listed));
  assert.deepEqual((await new SideChatStore(path).list()).map((s) => s.id), [id]);
});

test('subscriptions: validation and missing ids', async () => {
  const { store: s } = await freshStore();
  await assert.rejects(s.put({ name: '', baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' }), /name required/);
  await assert.rejects(s.put({ name: 'n', baseUrl: 'ftp://x', model: 'm', apiKey: 'k' }), /base URL/);
  await assert.rejects(s.put({ name: 'n', baseUrl: 'https://x/v1', model: '', apiKey: 'k' }), /model required/);
  await assert.rejects(s.put({ name: 'n', baseUrl: 'https://x/v1', model: 'm' }), /API key required/);
  await assert.rejects(s.put({ id: 'nope', name: 'n', baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' }), /not found/);
  await assert.rejects(s.remove('nope'), /not found/);
  await assert.rejects(s.setDefault('nope'), /not found/);
  await assert.rejects(s.chat('u1', 'hi', ctx), /no chat subscription/);
});

test('chat: posts OpenAI-compatible request and keeps history', async () => {
  const { store } = await subscribed();
  let reply!: Awaited<ReturnType<typeof store.chat>>;
  await withFetch(() => ok(JSON.stringify({ content: 'looks good', followups: [] })), async () => {
    reply = await store.chat('u1', 'review this', ctx);
  });
  assert.equal(reply.message.text, 'looks good');
  assert.deepEqual(reply.followups, []);
  assert.deepEqual((await store.history('u1')).map((m) => [m.role, m.text]), [
    ['user', 'review this'],
    ['assistant', 'looks good'],
  ]);
});

test('listChats: newest first, with previews, counts, and search', async () => {
  const { store } = await subscribed();
  const chat = (uid: string, text: string) =>
    withFetch(() => ok(JSON.stringify({ content: `re:${text}`, followups: [] })), async () => {
      await store.chat(uid, text, ctx);
    });
  await chat('aaa', 'review the auth flow');
  await chat('bbb', 'explain pagination');
  await chat('aaa', 'and the login page');

  const all = await store.listChats();
  assert.deepEqual(all.map((c) => c.uid), ['aaa', 'bbb']);
  const [first] = all;
  assert.equal(first.count, 4);
  assert.equal(first.title, 'aaa'); // no session row: uid fallback
  assert.match(first.preview, /re:and the login page/);
  assert.ok(first.lastAt >= first.firstAt && first.firstAt > 0);

  assert.deepEqual((await store.listChats('pagination')).map((c) => c.uid), ['bbb']);
  assert.deepEqual((await store.listChats('AAA')).map((c) => c.uid), ['aaa']);
  assert.deepEqual(await store.listChats('no such text'), []);
});

test('parseStructured: strict shape, tolerant envelope', () => {
  assert.deepEqual(parseStructured(JSON.stringify({ content: 'hi', followups: [{ title: 'Send it', kind: 'session', text: 'go' }] })), {
    content: 'hi',
    followups: [{ title: 'Send it', kind: 'session', text: 'go' }],
  });
  const fenced = 'sure:\n```json\n' + JSON.stringify({ content: 'hi', followups: [] }) + '\n```\ndone';
  assert.deepEqual(parseStructured(fenced), { content: 'hi', followups: [] });
  // Plain prose is the answer itself, never an error.
  assert.deepEqual(parseStructured('just some words'), { content: 'just some words', followups: [] });
  // Misshapen follow-ups are dropped, extras trimmed, content fallback intact.
  assert.deepEqual(
    parseStructured(
      JSON.stringify({
        content: 'hi',
        followups: [
          { title: 'A', kind: 'chat', text: 'q' },
          { title: 'B', kind: 'bogus', text: 'q' },
          { title: '', kind: 'session', text: 'q' },
          { title: 'C', kind: 'session', text: 'go' },
        ],
      }),
    ),
    {
      content: 'hi',
      followups: [
        { title: 'A', kind: 'chat', text: 'q' },
        { title: 'C', kind: 'session', text: 'go' },
      ],
    },
  );
  assert.deepEqual(parseStructured(JSON.stringify({ followups: [] })), { content: JSON.stringify({ followups: [] }), followups: [] });
});

test('chat: request carries key, model and session context', async () => {
  const { store, id } = await subscribed();
  let seen: { url: unknown; init: unknown }[] = [];
  await withFetch(
    (s) => {
      seen = s;
      return ok('ok');
    },
    async () => {
      await store.chat('u2', 'explain', { ...ctx, diff: '' }, id);
    },
  );
  const [call] = seen;
  assert.equal(call.url, 'https://api.example.com/v1/chat/completions');
  const init = call.init as { headers: Record<string, string>; body: string };
  assert.equal(init.headers.authorization, 'Bearer key');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'model');
  const system = body.messages[0].content as string;
  assert.match(system, /Session: vest/);
  assert.match(system, /Branch: gui-support/);
  assert.match(system, /Pull request: #12/);
  assert.match(system, /working tree clean/);
});

test('chat: provider failures surface cleanly', async () => {
  const { store } = await subscribed();
  await withFetch(() => new Response('overloaded', { status: 500 }), async () => {
    await assert.rejects(store.chat('u3', 'hi', ctx), /chat provider: 500 overloaded/);
  });
  await withFetch(
    () => {
      throw new Error('down');
    },
    async () => {
      await assert.rejects(store.chat('u3', 'hi', ctx), /unreachable/);
    },
  );
  await withFetch(() => ok('   '), async () => {
    await assert.rejects(store.chat('u3', 'hi', ctx), /empty reply/);
  });
  assert.deepEqual(await store.history('u3'), []);
});

async function fixtureRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'ah-sidechat-ctx-'));
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  await writeFile(join(dir, 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  return { dir, g };
}

test('changeContext: tracked diff plus new-file contents plus recent log', async () => {
  const { dir } = await fixtureRepo();
  await writeFile(join(dir, 'a.txt'), 'hello changed\n');
  await writeFile(join(dir, 'new.txt'), 'brand new\n');
  await writeFile(join(dir, 'long.txt'), 'x'.repeat(5000));
  await writeFile(join(dir, 'bin.dat'), Buffer.from([0x89, 0x00, 0x01]));
  await writeFile(join(dir, 'big.txt'), 'y'.repeat(101_000));
  const { branch, diff } = await changeContext(dir);
  assert.equal(branch, 'main');
  assert.match(diff, /Recent commits:\n[0-9a-f]{7} init/);
  assert.match(diff, /\+hello changed/);
  assert.match(diff, /--- new file: new\.txt\nbrand new/);
  assert.match(diff, /\.\.\. \(truncated\)/);
  assert.match(diff, /--- new file: bin\.dat\n\(binary, not shown\)/);
  assert.match(diff, /--- new file: big\.txt\n\(too large, not shown\)/);
});

test('changeContext: clean tree says so, non-repo rejects', async () => {
  const { dir } = await fixtureRepo();
  const clean = await changeContext(dir);
  assert.match(clean.diff, /\(working tree clean\)/);
  assert.match(clean.diff, /Recent commits:/);
  await assert.rejects(changeContext(join(tmpdir(), `ah-sidechat-norepo-${process.pid}`)), /not a git repository/);
});


test('historic search jumps include messages older than the latest chat window', async () => {
  const { store, path } = await freshStore();
  const db = getDb(path);
  await db.chatMessage.createMany({ data: Array.from({ length: 80 }, (_, i) => ({ uid: 'old', role: 'user', text: `message ${i}`, at: i + 1 })) });
  const first = await db.chatMessage.findFirstOrThrow({ where: { uid: 'old' }, orderBy: { id: 'asc' } });
  assert.ok(!(await store.history('old')).some((m) => m.id === first.id));
  assert.ok((await store.history('old', first.id)).some((m) => m.id === first.id));
});
