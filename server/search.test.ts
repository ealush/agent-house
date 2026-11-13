import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMigrated, getDb } from './db.ts';
import { SearchIndexer, buildFtsMatch, combineResponses, entryText, tokenizeQuery, type SearchHit, type TranscriptSource } from './search.ts';

async function freshDb() {
  const path = join(tmpdir(), `ah-search-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await ensureMigrated(path);
  return { path, db: getDb(path) };
}

const userLine = (text: string, at: string) =>
  JSON.stringify({ type: 'user', isSidechain: false, cwd: '/home/u/code/vest', timestamp: at, message: { role: 'user', content: [{ type: 'text', text }] } });
const agentLine = (text: string, at: string) =>
  JSON.stringify({ type: 'assistant', timestamp: at, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }] } });

async function writeTranscript(dir: string, name: string, lines: string[]): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, lines.join('\n') + '\n');
  return file;
}

test('query building: hostile input never becomes FTS syntax', () => {
  assert.equal(buildFtsMatch(''), null);
  assert.equal(buildFtsMatch('!!! ; --'), null);
  assert.equal(buildFtsMatch('"'), null);
  // Operators and punctuation are stripped down to plain quoted tokens: a
  // bare word like "or" in a MATCH string would be syntax, not a term.
  assert.equal(buildFtsMatch('login OR (flaky)'), '"login" AND "or" AND "flaky"*');
  assert.equal(buildFtsMatch('NEAR(a b)'), '"near" AND "a" AND "b"*');
  assert.equal(buildFtsMatch('"migration bug" fix'), '"migration bug" AND "fix"*');
  assert.equal(buildFtsMatch('drop"; DELETE FROM x'), '"drop" AND "delete" AND "from" AND "x"*');
  assert.deepEqual(tokenizeQuery('Hello, WORLD'), { terms: ['hello', 'world'], phrases: [] });
});

test('combineResponses: a dead host is a note, not a failed search', () => {
  const ok = { enabled: true, building: false, total: 0, tookMs: 5, notes: [], results: [] };
  const merged = combineResponses([
    { host: 'mini', body: ok },
    { host: 'mac', error: 'unreachable' },
  ]);
  assert.equal(merged.enabled, true);
  assert.deepEqual(merged.notes, [{ host: 'mac', error: 'unreachable' }]);
});

test('index + search: transcripts and chats, filters, status', async () => {
  const { db } = await freshDb();
  const dir = await mkdtemp(join(tmpdir(), 'ah-search-src-'));
  const file = await writeTranscript(dir, 'a.jsonl', [
    userLine('please look at the migration bug in the parser', '2026-10-01T10:00:00.000Z'),
    agentLine('the migration bug is a timezone offset in parseLegacy', '2026-10-01T10:01:00.000Z'),
    agentLine('also the cache invalidation is stale', '2026-10-01T10:02:00.000Z'),
  ]);
  const sources: TranscriptSource[] = [
    { file, harness: 'claude', adapter: 'claude', harnessId: 'abc', ref: 'sess1', uid: 'sess1', title: 'Migration bug hunt', cwd: '/home/u/code/vest', model: 'claude-opus-5-5' },
  ];
  await db.session.create({ data: { uid: 'sess1', title: 'Migration bug hunt', harness: 'claude', cwd: '/home/u/code/vest' } });
  await db.chatMessage.createMany({
    data: [
      { uid: 'sess1', role: 'user', text: 'what did the agent say about the quorum walrus?', at: 1759000000 },
      { uid: 'sess1', role: 'assistant', text: 'the quorum walrus keeps the raft log consistent', at: 1759000060 },
    ],
  });

  const ix = new SearchIndexer(db, async () => sources);
  await ix.refresh();

  const st = await ix.status();
  assert.equal(st.enabled, true);
  assert.equal(st.transcriptEntries, 3);
  assert.equal(st.chatEntries, 2);
  assert.equal(st.sourcesIndexed, 2);

  // A phrase in the transcript is found, grouped under its session, with the right seq jump target.
  const hit = await ix.search({ q: '"migration bug"' });
  assert.equal(hit.total, 1);
  assert.equal(hit.results[0].kind, 'transcript');
  assert.equal(hit.results[0].ref, 'sess1');
  assert.equal(hit.results[0].title, 'Migration bug hunt');
  assert.equal(hit.results[0].matches, 2);
  assert.equal(hit.results[0].excerpts[0].seq, 1);

  // Search in chats finds the message and its id.
  const chat = await ix.search({ q: 'quorum walrus' });
  assert.equal(chat.total, 1);
  assert.equal(chat.results[0].kind, 'chat');
  assert.equal(chat.results[0].excerpts[0].msgId, 2);

  // Filters narrow: role:user keeps only the user turn (seq 1).
  const userOnly = await ix.search({ q: 'migration', role: 'user' });
  assert.equal(userOnly.total, 1);
  assert.ok(userOnly.results[0].excerpts.every((e) => e.role === 'user'));
  // in:chats scopes away the transcript.
  const chatsOnly = await ix.search({ q: 'migration', scope: 'chats' });
  assert.equal(chatsOnly.total, 0);
  // p: matches cwd substring; a foreign project matches nothing.
  assert.equal((await ix.search({ q: 'migration', project: 'vest' })).total, 1);
  assert.equal((await ix.search({ q: 'migration', project: 'other' })).total, 0);
  // h: for another host returns nothing locally (the hub merge covers it).
  assert.equal((await ix.search({ q: 'migration', host: 'someone-else' })).total, 0);

  // Hostile queries never throw.
  for (const q of ['"', 'AND OR NOT', 'a"b', '(((', 'title:flaky', 'x'.repeat(500)]) {
    const r = await ix.search({ q });
    assert.ok(Array.isArray(r.results), q);
  }
});

test('incremental: appended lines become searchable; a replaced file drops stale matches', async () => {
  const { db } = await freshDb();
  const dir = await mkdtemp(join(tmpdir(), 'ah-search-src-'));
  const file = await writeTranscript(dir, 'b.jsonl', [userLine('first topic only', '2026-10-01T10:00:00.000Z')]);
  const sources: TranscriptSource[] = [
    { file, harness: 'claude', adapter: 'claude', harnessId: 'b1', ref: 'sessB', uid: 'sessB', title: 'B', cwd: '/x/bproj' },
  ];
  const ix = new SearchIndexer(db, async () => sources);
  await ix.refresh();
  assert.equal((await ix.search({ q: 'zebra' })).total, 0);

  // Append: indexed on the next refresh, no rebuild needed.
  await appendFile(file, agentLine('now a zebra appears', '2026-10-01T10:05:00.000Z') + '\n');
  await ix.refresh();
  const grown = await ix.search({ q: 'zebra' });
  assert.equal(grown.total, 1);
  assert.equal(grown.results[0].excerpts[0].seq, 2);

  // Replace (the /clear shape): size shrinks, stale content must not survive.
  await writeTranscript(dir, 'b.jsonl', [userLine('a fresh start with a walnut', '2026-10-02T10:00:00.000Z')]);
  await ix.refresh();
  assert.equal((await ix.search({ q: 'zebra' })).total, 0);
  assert.equal((await ix.search({ q: 'walnut' })).total, 1);
  assert.equal((await ix.status()).transcriptEntries, 1);
});

test('incremental: a half-written last line waits for its newline, then indexes at the right seq', async () => {
  const { db } = await freshDb();
  const dir = await mkdtemp(join(tmpdir(), 'ah-search-src-'));
  const file = await writeTranscript(dir, 'c.jsonl', [userLine('opening line', '2026-10-01T10:00:00.000Z'), '', agentLine('second line', '2026-10-01T10:01:00.000Z')]);
  const sources: TranscriptSource[] = [
    { file, harness: 'claude', adapter: 'claude', harnessId: 'c1', ref: 'sessC', uid: 'sessC', title: 'C', cwd: '/x/cproj' },
  ];
  const ix = new SearchIndexer(db, async () => sources);
  await ix.refresh();
  // An agent mid-write: the line has no newline yet, so it isn't read.
  const line = agentLine('a heron lands', '2026-10-01T10:02:00.000Z');
  await appendFile(file, line.slice(0, 20));
  await ix.refresh();
  assert.equal((await ix.search({ q: 'heron' })).total, 0);
  // Finished: the next pass reads on from where the last stopped.
  await appendFile(file, line.slice(20) + '\n');
  await ix.refresh();
  const hit = await ix.search({ q: 'heron' });
  assert.equal(hit.total, 1);
  assert.equal(hit.results[0].excerpts[0].seq, 4);
  await appendFile(file, userLine('and a crane', '2026-10-01T10:03:00.000Z') + '\n');
  await ix.refresh();
  assert.equal((await ix.search({ q: 'crane' })).results[0].excerpts[0].seq, 5);
  assert.equal((await ix.status()).transcriptEntries, 4);
});

test('disable drops the indexed content itself', async () => {
  const { db } = await freshDb();
  const dir = await mkdtemp(join(tmpdir(), 'ah-search-src-'));
  const file = await writeTranscript(dir, 'c.jsonl', [userLine('secret phrase quokka', '2026-10-01T10:00:00.000Z')]);
  const ix = new SearchIndexer(db, async () => [
    { file, harness: 'claude', adapter: 'claude', harnessId: 'c1', ref: 'sessC', uid: 'sessC', title: 'C', cwd: '/x/c' },
  ]);
  await ix.refresh();
  assert.equal((await ix.search({ q: 'quokka' })).total, 1);

  await ix.setEnabled(false);
  const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('transcript_fts', 'chat_fts', 'SearchSource')`,
  );
  assert.deepEqual(tables, []);
  assert.equal((await ix.search({ q: 'quokka' })).enabled, false);
  assert.equal((await ix.status()).enabled, false);
});

test('ranking is deterministic and a 200-conversation corpus answers fast', async () => {
  const { db } = await freshDb();
  const dir = await mkdtemp(join(tmpdir(), 'ah-search-corpus-'));
  const sources: TranscriptSource[] = [];
  for (let i = 0; i < 200; i++) {
    const lines = Array.from({ length: 10 }, (_, j) =>
      j % 2 ? agentLine(`entry ${j} of session ${i} discussing the parser and other work`, '2026-10-01T10:00:00.000Z') : userLine(`session ${i} turn ${j} about the parser`, '2026-10-01T10:00:00.000Z'),
    );
    const file = await writeTranscript(dir, `s${i}.jsonl`, lines);
    sources.push({
      file, harness: 'claude', adapter: 'claude', harnessId: `h${i}`, ref: `s${i}`, uid: `s${i}`,
      title: i === 42 ? 'All about the parser' : `Session ${i}`, cwd: '/x/proj',
    });
  }
  const ix = new SearchIndexer(db, async () => sources);
  const build0 = Date.now();
  await ix.refresh();
  const buildMs = Date.now() - build0;
  assert.equal((await ix.status()).transcriptEntries, 2000);

  const t0 = Date.now();
  const r = await ix.search({ q: 'parser' });
  const ms = Date.now() - t0;
  assert.equal(r.total, 200);
  assert.equal(r.results[0].matches, 10);
  const pages = await Promise.all(Array.from({ length: 4 }, (_, i) => ix.search({ q: 'parser', limit: 50, offset: i * 50 })));
  assert.equal(new Set(pages.flatMap((p) => p.results.map((h) => h.ref))).size, 200);
  // The session whose title names the topic ranks first; repeat queries agree.
  assert.equal(r.results[0].ref, 's42');
  const again = await ix.search({ q: 'parser' });
  assert.deepEqual(again.results.map((x) => x.ref), r.results.map((x) => x.ref));
  assert.ok(ms < 500, `search took ${ms} ms`);
  console.log(`corpus: build ${buildMs} ms, search ${ms} ms over 2000 entries`);
});


test('documents, partial JSONL writes, reference changes and server date filters', async () => {
  const { db } = await freshDb();
  const dir = await mkdtemp(join(tmpdir(), 'ah-search-formats-'));
  const file = join(dir, 'gemini.json');
  await writeFile(file, JSON.stringify({ sessionId: 'gem', messages: [{ id: 'm', type: 'user', timestamp: '2026-10-01T10:00:00Z', content: 'document unicorn' }] }));
  const lineFile = join(dir, 'partial.jsonl');
  const line = userLine('partial unicorn', '2026-10-02T10:00:00Z');
  await writeFile(lineFile, line.slice(0, -5));
  const sources: TranscriptSource[] = [
    { file, harness: 'gemini', adapter: 'gemini', harnessId: 'gem', ref: 'gemini:gem', uid: null, title: 'Gemini', cwd: '/x' },
    { file: lineFile, harness: 'claude', adapter: 'claude', harnessId: 'partial', ref: 'partial', uid: null, title: 'Partial', cwd: '/x' },
  ];
  const ix = new SearchIndexer(db, async () => sources);
  await ix.refresh();
  assert.equal((await ix.search({ q: 'unicorn' })).total, 1);
  await appendFile(lineFile, line.slice(-5) + '\n');
  await ix.refresh();
  assert.equal((await ix.search({ q: 'unicorn' })).total, 2);
  assert.equal((await ix.search({ q: 'unicorn', from: Date.parse('2026-10-02') })).total, 1);
  sources[1].ref = 'registered'; sources[1].uid = 'registered'; sources[1].title = 'Registered';
  await ix.refresh();
  const hits = await ix.search({ q: 'partial' });
  assert.equal(hits.total, 1); assert.equal(hits.results[0].ref, 'registered');
  // A toggle racing with requests must not recreate tables or throw.
  await Promise.all([ix.refresh(), ix.setEnabled(false), ix.search({ q: 'unicorn' }), ix.status()]);
  assert.equal((await ix.search({ q: 'unicorn' })).enabled, false);
  const tables = await db.$queryRawUnsafe(`SELECT name FROM sqlite_master WHERE name IN ('transcript_fts', 'chat_fts', 'SearchSource')`);
  assert.deepEqual(tables, []);
});

test('aggregate totals and global offsets retain distinct hosts', () => {
  const hit = (ref: string, at: number): SearchHit => ({ kind: 'transcript', host: 'internal', ref, uid: null, harness: 'claude', harnessId: ref, title: ref, cwd: '/x', at, matches: 1, excerpts: [] });
  const body = (results: SearchHit[], total: number) => ({ enabled: true, building: false, total, tookMs: 1, notes: [], results });
  const out = combineResponses([
    { host: 'a', body: body([hit('same', 10), hit('old', 5)], 100) },
    { host: 'b', body: body([hit('same', 9), hit('older', 4)], 50) },
  ], { offset: 1, limit: 2 });
  assert.equal(out.total, 150);
  assert.deepEqual(out.results.map((h) => [h.host, h.ref]), [['b', 'same'], ['a', 'old']]);
});


test('opencode SQLite transcripts are indexed and rewritten tool output replaces stale text', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { db } = await freshDb();
  const dir = await mkdtemp(join(tmpdir(), 'ah-search-opencode-'));
  const file = join(dir, 'opencode.db');
  const doc = new DatabaseSync(file);
  try {
    doc.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
    doc.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m', 's', 1, JSON.stringify({ role: 'user', time: { created: 1000 } }));
    doc.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p', 'm', 's', 1, JSON.stringify({ type: 'text', text: 'old opencode walnut' }));
    const ix = new SearchIndexer(db, async () => [{ file: `${file}#s`, harness: 'opencode', adapter: 'opencode', harnessId: 's', ref: 'opencode:s', uid: null, title: 'Open', cwd: '/x' }]);
    await ix.refresh();
    assert.equal((await ix.search({ q: 'walnut' })).total, 1);
    doc.prepare('UPDATE part SET data = ?').run(JSON.stringify({ type: 'text', text: 'new opencode quokka' }));
    await ix.refresh();
    assert.equal((await ix.search({ q: 'walnut' })).total, 0);
    assert.equal((await ix.search({ q: 'quokka' })).results[0].excerpts[0].seq, 1);
  } finally { doc.close(); }
});

test('a tool call is indexed as the words in it, not its JSON', () => {
  const text = entryText({
    seq: 1, id: '1', role: 'assistant', step: 'message', at: 0,
    parts: [{ type: 'tool_call', call: { id: 't', name: 'Bash', args: { command: 'echo hi > hello.txt', description: 'Create hello.txt with the word "hi"', timeout: 5 } } }],
  } as never);
  assert.equal(text, 'Bash: echo hi > hello.txt · Create hello.txt with the word "hi" · 5');
});
