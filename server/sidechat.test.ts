import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SideChatStore, changeContext, parseStructured, repoToolEnv, runRepoTool, type ChatContext } from './sidechat.ts';
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

test('side chats key to the conversation and migrate legacy uid rows', async () => {
  const { store, path } = await subscribed();
  assert.equal(store.chatKey('muse', 'conv1', 'u1'), 'muse:conv1');
  assert.equal(store.chatKey('shell', null, 'u1'), 'u1');
  assert.equal(store.chatKey(null, null, 'u1'), 'u1');
  await withFetch(() => ok(JSON.stringify({ content: 'before id known', followups: [] })), async () => {
    await store.chat('u1', 'early question', ctx);
  });
  // The harness id is learned later (adoption); history migrates to the key.
  await store.rekey('u1', 'muse:conv1');
  assert.deepEqual((await store.history('muse:conv1')).map((m) => m.text), ['early question', 'before id known']);
  assert.deepEqual(await store.history('u1'), [], 'legacy rows moved, not copied');
  await withFetch(() => ok(JSON.stringify({ content: 'after', followups: [] })), async () => {
    await store.chat('muse:conv1', 'follow-up', ctx);
  });
  assert.equal((await store.history('muse:conv1')).length, 4, 'one merged conversation');
  // Titles follow the conversation key through the session row.
  const db = getDb(path);
  await db.session.create({ data: { uid: 'other-uid', harness: 'muse', harnessId: 'conv1', title: 'My session', cwd: '/p' } });
  const found = (await store.listChats()).find((c) => c.uid === 'muse:conv1');
  assert.equal(found?.title, 'My session');
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
  // Code fences inside content are markdown, not a wrapper around the JSON.
  const fencedAnswer = '### Checks\n```bash\ngit diff\n```\n- done';
  assert.deepEqual(
    parseStructured(JSON.stringify({ content: fencedAnswer, followups: [{ title: 'Summarize diff', kind: 'session', text: 'Summarize the diff' }] })),
    { content: fencedAnswer, followups: [{ title: 'Summarize diff', kind: 'session', text: 'Summarize the diff' }] },
  );
});

test('history: shows the answer when a stored reply is still the raw envelope', async () => {
  const { store, path } = await freshStore();
  const answer = '### Checks\n```bash\ngit diff\n```\n- done';
  const raw = JSON.stringify({ content: answer, followups: [{ title: 'Summarize diff', kind: 'session', text: 'Summarize the diff' }] });
  const db = getDb(path);
  await db.chatMessage.create({ data: { uid: 'broken', role: 'assistant', text: raw, at: 1 } });
  await db.chatMessage.create({ data: { uid: 'pasted', role: 'user', text: raw, at: 1 } });
  const example = 'Use this response shape:\n```json\n' + JSON.stringify({ content: 'Example', followups: [] }) + '\n```';
  await db.chatMessage.create({ data: { uid: 'example', role: 'assistant', text: example, at: 1 } });
  await db.chatMessage.create({ data: { uid: 'fenced', role: 'assistant', text: '```json\n' + raw + '\n```', at: 1 } });
  assert.equal((await store.history('broken'))[0].text, answer);
  assert.equal((await store.history('pasted'))[0].text, raw);
  assert.equal((await store.history('example'))[0].text, example);
  assert.equal((await store.history('fenced'))[0].text, answer);
  for (const text of ['```json\n{"answer":"example"}\n```', JSON.stringify([{ content: 'example' }])]) {
    await db.chatMessage.create({ data: { uid: 'json-data', role: 'assistant', text, at: 1 } });
    assert.equal((await store.history('json-data')).at(-1)!.text, text);
  }
  const chats = await store.listChats();
  assert.match(chats.find((c) => c.uid === 'broken')!.preview, /^### Checks/);
  assert.match(chats.find((c) => c.uid === 'pasted')!.preview, /^\{"content"/);
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
  assert.ok(!('tools' in body), 'no repo dir in context: legacy one-shot, no tools offered');
  const system = body.messages[0].content as string;
  assert.match(system, /Session: vest/);
  assert.match(system, /Branch: gui-support/);
  assert.match(system, /Pull request: #12/);
  assert.match(system, /working tree clean/);
  assert.match(system, /beyond the context given/);
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


const toolCall = (name: string, args: unknown = {}) =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const finalAnswer = (content: string) => ok(JSON.stringify({ content, followups: [] }));

async function dirtyRepo() {
  const { dir, g } = await fixtureRepo();
  await writeFile(join(dir, 'b.txt'), 'second file\n');
  g('add', '.');
  g('commit', '-qm', 'second');
  await writeFile(join(dir, 'a.txt'), 'hello changed\n');
  await writeFile(join(dir, 'b.txt'), 'second file changed\n');
  return { dir, g };
}

test('chat: repo tools run server-side and feed the answer', async () => {
  const { dir } = await dirtyRepo();
  const { store } = await subscribed();
  const seen: { url: unknown; init: unknown }[] = [];
  let reply!: Awaited<ReturnType<typeof store.chat>>;
  await withFetch(
    (s) => {
      seen.push(...s.splice(0));
      return seen.length === 1 ? toolCall('working_diff') : finalAnswer('two files changed');
    },
    async () => {
      reply = await store.chat('tools-u', 'what changed?', { ...ctx, dir, diff: '' });
    },
  );
  assert.equal(reply.message.text, 'two files changed');
  assert.equal(seen.length, 2);
  const first = JSON.parse((seen[0].init as { body: string }).body);
  assert.ok(Array.isArray(first.tools) && first.tools.some((t: { function: { name: string } }) => t.function?.name === 'working_diff'), 'tools offered on the first round');
  const second = JSON.parse((seen[1].init as { body: string }).body);
  const toolMsg = second.messages.find((m: { role: string }) => m.role === 'tool');
  assert.match(toolMsg.content, /\+hello changed/, 'uncommitted diff reached the model without a dump up front');
  assert.match(JSON.stringify(second.messages.find((m: { role: string }) => m.role === 'system')), /repo tools/);
  // Tool chatter is ephemeral: history keeps the answer only.
  assert.deepEqual((await store.history('tools-u')).map((m) => [m.role, m.text]), [
    ['user', 'what changed?'],
    ['assistant', 'two files changed'],
  ]);
});

test('chat: providers without function calling fall back to one-shot', async () => {
  const { dir } = await dirtyRepo();
  const { store } = await subscribed();
  const bodies: string[] = [];
  await withFetch(
    (s) => {
      const init = s[s.length - 1].init as { body: string };
      bodies.push(init.body);
      return JSON.parse(init.body).tools ? new Response('{"error":{"message":"tools are not supported"}}', { status: 400 }) : finalAnswer('plain answer');
    },
    async () => {
      const reply = await store.chat('fallback-u', 'hi', { ...ctx, dir, diff: '' });
      assert.equal(reply.message.text, 'plain answer');
    },
  );
  assert.equal(bodies.length, 2);
  assert.ok(JSON.parse(bodies[0]).tools, 'tried tools first');
  assert.ok(!('tools' in JSON.parse(bodies[1])), 'retried without tools');
});

test('chat: a model that only calls tools still terminates', async () => {
  const { dir } = await dirtyRepo();
  const { store } = await subscribed();
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      // Six tool rounds, then the budget nudge, then a final plain answer.
      return calls <= 6 ? toolCall('working_diff') : finalAnswer('done');
    },
    async () => {
      const reply = await store.chat('budget-u', 'hi', { ...ctx, dir, diff: '' });
      assert.equal(reply.message.text, 'done');
    },
  );
  assert.equal(calls, 7, `six tool rounds plus the final answer (saw ${calls})`);
});

test('runRepoTool: patches slice by path, reads confine to the repo', async () => {
  const { dir, g } = await dirtyRepo();
  const env = await repoToolEnv(dir, null, 'main');
  assert.ok(env);
  const whole = await runRepoTool(env, 'working_diff', {});
  assert.match(whole, /diff --git a\/a\.txt b\/a\.txt/, 'canonical prefixes regardless of diff.mnemonicprefix');
  const onlyB = await runRepoTool(env, 'working_diff', { paths: ['b.txt'] });
  assert.match(onlyB, /second file/);
  assert.ok(!onlyB.includes('hello changed'), 'other hunks filtered out');
  assert.match(await runRepoTool(env, 'working_diff', { paths: ['nope.txt'] }), /no patch hunks for: nope\.txt/);
  assert.match(await runRepoTool(env, 'read_file', { path: 'a.txt', ref: 'HEAD' }), /^hello$/m);
  assert.match(await runRepoTool(env, 'read_file', { path: '../evil' }), /escapes the repo/);
  assert.match(await runRepoTool(env, 'read_file', { path: 'a.txt', ref: 'whatever' }), /must be 'working', 'HEAD', or 'base'/);
  assert.match(await runRepoTool(env, 'commit_show', { sha: 'zzz' }), /invalid commit sha/);
  const sha = g('rev-parse', 'HEAD').toString().trim();
  assert.match(await runRepoTool(env, 'commit_show', { sha }), /second/);
  assert.match(await runRepoTool(env, 'pr_diff', {}), /No pull request in context/);
  assert.match(await runRepoTool(env, 'pr_info', {}), /No pull request in context/);
  assert.match(await runRepoTool(env, 'bogus', {}), /Unknown tool/);
});

test('repoToolEnv: null outside a repo', async () => {
  assert.equal(await repoToolEnv(undefined, null, null), null);
  assert.equal(await repoToolEnv(join(tmpdir(), `ah-sidechat-nondir-${process.pid}`), null, null), null);
});

test('historic search jumps include messages older than the latest chat window', async () => {
  const { store, path } = await freshStore();
  const db = getDb(path);
  await db.chatMessage.createMany({ data: Array.from({ length: 80 }, (_, i) => ({ uid: 'old', role: 'user', text: `message ${i}`, at: i + 1 })) });
  const first = await db.chatMessage.findFirstOrThrow({ where: { uid: 'old' }, orderBy: { id: 'asc' } });
  assert.ok(!(await store.history('old')).some((m) => m.id === first.id));
  assert.ok((await store.history('old', first.id)).some((m) => m.id === first.id));
});
