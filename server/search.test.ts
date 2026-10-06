import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMigrated, getDb } from './db.ts';
import { SearchIndexer, buildFtsMatch, combineResponses, tokenizeQuery, type TranscriptSource } from './search.ts';

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
  assert.ok(r.total > 0);
  // The session whose title names the topic ranks first; repeat queries agree.
  assert.equal(r.results[0].ref, 's42');
  const again = await ix.search({ q: 'parser' });
  assert.deepEqual(again.results.map((x) => x.ref), r.results.map((x) => x.ref));
  assert.ok(ms < 2000, `search took ${ms} ms`);
  console.log(`corpus: build ${buildMs} ms, search ${ms} ms over 2000 entries`);
});
