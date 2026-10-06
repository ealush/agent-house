import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeLine } from './feed/adapters/claude.ts';
import { parseCodexLine } from './feed/adapters/codex.ts';
import { parseGrokLine } from './feed/adapters/grok.ts';
import { parseMuseLine } from './feed/adapters/muse.ts';
import { parseGeminiLine, parseGeminiDocument } from './feed/adapters/gemini.ts';
import { opencodeEntries, loadOpencode } from './feed/adapters/opencode.ts';
import { textParts, clip } from './feed/parts.ts';
import { TranscriptFeed, DocumentFeed, ADAPTERS, DOC_ADAPTERS } from './feed/feed.ts';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const fixtureJson = async (name: string) => JSON.parse(await readFile(fixture(name), 'utf8'));

const at = '2026-10-05T12:00:00.000Z';

test('claude: assistant text, thinking and tool calls become typed parts', () => {
  const e = parseClaudeLine(
    {
      type: 'assistant',
      uuid: 'u1',
      timestamp: at,
      message: {
        content: [
          { type: 'thinking', thinking: 'plan it' },
          { type: 'text', text: 'Running tests.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } },
        ],
      },
    },
    7,
  );
  assert.deepEqual(e, {
    seq: 7,
    id: 'u1',
    role: 'assistant',
    step: 'tool_execution',
    at: Date.parse(at),
    parts: [
      { type: 'reasoning', text: 'plan it' },
      { type: 'text', text: 'Running tests.' },
      { type: 'tool_call', call: { id: 't1', name: 'Bash', args: { command: 'pnpm test' } } },
    ],
  });
});

test('claude: tool results carry text, error flag and small structure, not file bodies', () => {
  const e = parseClaudeLine(
    {
      type: 'user',
      uuid: 'u2',
      timestamp: at,
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] },
      toolUseResult: { filePath: '/x', structuredPatch: [{ lines: ['+a'] }], originalFile: 'huge' },
    },
    8,
  )!;
  assert.equal(e.role, 'tool');
  assert.deepEqual(e.parts, [{ type: 'tool_result', result: { callId: 't1', text: 'ok', isError: false, data: { filePath: '/x', structuredPatch: [{ lines: ['+a'] }] } } }]);
});

test('claude: injected context is skipped, slash commands and interruptions are kept', () => {
  const user = (content: unknown, extra = {}) => parseClaudeLine({ type: 'user', uuid: 'u', timestamp: at, message: { content }, ...extra }, 1);
  assert.equal(user('<system-reminder>x</system-reminder>'), null);
  assert.equal(user('hello', { isMeta: true }), null);
  assert.equal(user('hi', { isSidechain: true }), null);
  assert.deepEqual(user('<command-name>/model</command-name>\n<command-args>opus</command-args>')!.parts, [{ type: 'text', text: '/model opus' }]);
  assert.deepEqual(user([{ type: 'text', text: '[Request interrupted by user]' }])!.parts, [{ type: 'notice', kind: 'interrupted', text: 'Interrupted' }]);
  assert.deepEqual(user('fix the bug')!.parts, [{ type: 'text', text: 'fix the bug' }]);
  assert.equal(parseClaudeLine({ type: 'ai-title', aiTitle: 'x' }, 2), null);
});

test('codex: messages, calls and outputs pair by call id; injected context is skipped', () => {
  const line = (payload: object, type = 'response_item') => parseCodexLine({ timestamp: at, type, payload }, 3);
  assert.equal(line({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] }), null);
  assert.equal(line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…' }] }), null);
  assert.deepEqual(line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'review PR 12' }] })!.parts, [{ type: 'text', text: 'review PR 12' }]);
  assert.deepEqual(line({ type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' })!.parts, [
    { type: 'tool_call', call: { id: 'c1', name: 'shell', args: { command: ['ls'] } } },
  ]);
  const out = line({ type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'boom', metadata: { exit_code: 2 } }) })!;
  assert.equal(out.role, 'tool');
  assert.deepEqual(out.parts, [{ type: 'tool_result', result: { callId: 'c1', text: 'boom', isError: true, data: { exit_code: 2 } } }]);
  assert.deepEqual(line({ type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch', call_id: 'c2' })!.parts, [
    { type: 'tool_call', call: { id: 'c2', name: 'apply_patch', args: { input: '*** Begin Patch' } } },
  ]);
  assert.equal(line({ type: 'reasoning', summary: [], encrypted_content: 'x' }), null);
  assert.deepEqual(line({ type: 'turn_aborted' }, 'event_msg')!.parts, [{ type: 'notice', kind: 'interrupted', text: 'Interrupted' }]);
});

test('grok: user wrapper and synthetics, assistant tool calls, results and reasoning', async () => {
  const lines = (await readFile(fixture('grok/chat_history.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const entries = lines.map((l, i) => parseGrokLine(l, i + 1)).filter(Boolean) as NonNullable<ReturnType<typeof parseGrokLine>>[];
  // system, the synthetic context line: skipped. Everything else maps.
  assert.deepEqual(entries.map((e) => e.role), ['user', 'assistant', 'assistant', 'tool', 'assistant', 'assistant']);
  assert.deepEqual(entries[0].parts, [{ type: 'text', text: 'Fix the failing build' }]);
  assert.deepEqual(entries[1].parts, [{ type: 'reasoning', text: 'Run the build and read the error.' }]);
  assert.deepEqual(entries[2].parts, [{ type: 'tool_call', call: { id: 'call-1', name: 'run_terminal_command', args: { command: 'pnpm build' } } }]);
  const result = entries[3].parts[0] as any;
  assert.equal(result.result.callId, 'call-1');
  assert.equal(result.result.isError, true); // no error flag in the format; the text leads with "Error:"
  assert.ok(entries[4].parts.some((p) => p.type === 'widget'));
  assert.equal((entries[5].parts[0] as any).call.name, 'web_search');
  assert.equal(parseGrokLine({ type: 'something_new' }, 9), null);
  assert.equal(parseGrokLine(null, 9), null);
});

test('muse: envelope records map the four conversation event kinds only', async () => {
  const lines = (await readFile(fixture('muse.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const entries = lines.map((l, i) => parseMuseLine(l, i + 1)).filter(Boolean) as NonNullable<ReturnType<typeof parseMuseLine>>[];
  assert.deepEqual(entries.map((e) => e.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(entries[0].at, 1785972469000); // recorded_at is microseconds
  assert.deepEqual(entries[1].parts, [{ type: 'tool_call', call: { id: 'c1', name: 'read_file', args: { path: 'src/login.ts' } } }]);
  assert.equal((entries[2].parts[0] as any).result.callId, 'c1');
  assert.deepEqual(entries[3].parts, [{ type: 'text', text: 'Fixed the redirect.' }]);
  assert.equal(parseMuseLine({ payload_type: 'runtime.session' }, 1), null);
});

test('gemini: metadata is skipped, records map text, thoughts, calls and results', async () => {
  const lines = (await readFile(fixture('gemini.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const entries = lines.map((l, i) => parseGeminiLine(l, i + 1)).filter(Boolean) as NonNullable<ReturnType<typeof parseGeminiLine>>[];
  assert.deepEqual(entries.map((e) => e.role), ['user', 'assistant', 'assistant', 'tool', 'system']);
  assert.deepEqual(entries[0].parts, [{ type: 'text', text: 'Fix the parser' }]);
  const kinds = entries[1].parts.map((p) => p.type);
  assert.deepEqual(kinds, ['reasoning', 'text', 'tool_call', 'tool_result']);
  assert.equal((entries[1].parts[3] as any).result.text, 'parser.ts');
  assert.equal((entries[2].parts.find((p) => p.type === 'tool_call') as any).call.name, 'read_file');
  assert.equal((entries[3].parts[0] as any).result.callId, 'call-2');
});

test('gemini: the legacy single-document form parses through the document path', async () => {
  const doc = await fixtureJson('gemini-legacy.json');
  const entries = parseGeminiDocument(doc);
  assert.deepEqual(entries.map((e) => [e.seq, e.role]), [[1, 'user'], [2, 'assistant']]);
  assert.equal((entries[1].parts.find((p) => p.type === 'tool_result') as any).result.isError, true);
  const viaLoader = await DOC_ADAPTERS.gemini(fixture('gemini-legacy.json'));
  assert.deepEqual(viaLoader?.map((e) => e.seq), [1, 2]);
  assert.equal(await DOC_ADAPTERS.gemini(fixture('gemini.jsonl')), null); // JSONL belongs to the line adapter
});

test('opencode: legacy tree messages and parts become entries; tool state folds in', async () => {
  const entries = await loadOpencode(fixture('opencode/storage/session/proj1/ses_fixture1.json'));
  assert.ok(entries);
  assert.deepEqual(entries.map((e) => e.role), ['user', 'assistant']);
  assert.deepEqual(entries[0].parts, [{ type: 'text', text: 'Fix the parser' }]);
  assert.deepEqual(entries[1].parts.map((p) => p.type), ['reasoning', 'tool_call', 'tool_result']);
  assert.equal((entries[1].parts[2] as any).result.text, 'parser.ts');
  assert.deepEqual(opencodeEntries([{ id: 'm', role: 'user', at: 0, parts: [{ type: 'step-start' }] }]), []);
  assert.equal(await loadOpencode(fixture('opencode/storage/session/proj1/missing.json')), null);
});

test('opencode: the SQLite store reads read-only through the document loader', async () => {
  const { DatabaseSync } = (await import('node:sqlite')) as any;
  const dir = await mkdtemp(join(tmpdir(), 'ah-opencode-'));
  const dbFile = join(dir, 'opencode.db');
  try {
    const db = new DatabaseSync(dbFile);
    db.exec('CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_updated INTEGER, parent_id TEXT)');
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
    db.exec('CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, NULL)').run('ses_db', '/home/u/code/proj', 'DB session', 1759669500000);
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg_1', 'ses_db', 1759669201000, JSON.stringify({ role: 'user', time: { created: 1759669201000 } }));
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('prt_1', 'msg_1', 'ses_db', 1759669201000, JSON.stringify({ type: 'text', text: 'Hello from the db' }));
    db.close();
    const entries = await loadOpencode(`${dbFile}#ses_db`);
    assert.deepEqual(entries?.map((e) => e.parts), [[{ type: 'text', text: 'Hello from the db' }]]);
    assert.equal(await loadOpencode(`${join(dir, 'nope.db')}#ses_db`), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('document feed: growth appends, identity change rebuilds, junk is ignored', async () => {
  let doc: any = await fixtureJson('gemini-legacy.json');
  const feed = new DocumentFeed('mem', async () => parseGeminiDocument(doc));
  await feed.update();
  assert.equal(feed.entries.length, 2);
  assert.equal(feed.head, 2);
  doc = { ...doc, messages: [...doc.messages, { id: 'm3', timestamp: '2026-10-04T09:01:00.000Z', type: 'user', content: 'And in prod?' }] };
  await feed.update();
  assert.equal(feed.generation, 0);
  assert.deepEqual(feed.after(2).map((e) => e.seq), [3]);
  doc = { ...doc, messages: [{ id: 'x1', timestamp: '2026-10-04T09:00:01.000Z', type: 'user', content: 'Different conversation' }] };
  await feed.update();
  assert.equal(feed.generation, 1);
  assert.equal(feed.entries.length, 1);
});

test('feed: a large grok transcript reads fully and in order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-feed-big-'));
  const file = join(dir, 'chat_history.jsonl');
  try {
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) lines.push(JSON.stringify({ type: 'assistant', content: `line ${i}`, model_id: 'grok-4.5' }));
    await writeFile(file, lines.join('\n') + '\n');
    const feed = new TranscriptFeed(file, ADAPTERS.grok);
    await feed.update();
    assert.equal(feed.entries.length, 5000); // MAX_ENTRIES cap, floor rises
    assert.ok(feed.floor > 1);
    assert.equal((feed.entries.at(-1)?.parts[0] as any).text, 'line 9999');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('widgets: fenced ah-widget JSON becomes a widget part; anything else stays text', () => {
  const md = 'Results:\n\n```ah-widget\n{"type":"stats","items":[{"label":"Tests","value":104}]}\n```\n\nDone.\n\n```ah-widget\nnot json\n```';
  assert.deepEqual(textParts(md), [
    { type: 'text', text: 'Results:' },
    { type: 'widget', widget: { type: 'stats', items: [{ label: 'Tests', value: 104 }] } },
    { type: 'text', text: 'Done.\n\n```ah-widget\nnot json\n```' },
  ]);
  assert.deepEqual(textParts('```ah-widget\n{"no":"type"}\n```'), [{ type: 'text', text: '```ah-widget\n{"no":"type"}\n```' }]);
});

test('clip keeps head and tail', () => {
  const { text, truncated } = clip('a'.repeat(100) + 'END', 40);
  assert.ok(truncated);
  assert.ok(text.startsWith('aaa') && text.endsWith('END'));
});

test('feed: reads incrementally across partial lines, numbers by line, rebuilds on truncation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-feed-'));
  const file = join(dir, 's.jsonl');
  const user = (text: string) => JSON.stringify({ type: 'user', uuid: text, timestamp: at, message: { content: text } });
  try {
    await writeFile(file, `${user('one')}\n${JSON.stringify({ type: 'ai-title', aiTitle: 't' })}\n${user('two').slice(0, 20)}`);
    const feed = new TranscriptFeed(file, ADAPTERS.claude);
    await feed.update();
    assert.deepEqual(feed.entries.map((e) => [e.seq, e.id]), [[1, 'one']]);
    assert.equal(feed.head, 2);

    await appendFile(file, `${user('two').slice(20)}\n${user('ünï')}\n`);
    await feed.update();
    assert.deepEqual(feed.entries.map((e) => [e.seq, e.id]), [[1, 'one'], [3, 'two'], [4, 'ünï']]);
    assert.deepEqual(feed.after(1).map((e) => e.seq), [3, 4]);
    assert.deepEqual(feed.page(4, 1), { entries: [feed.entries[1]], hasOlder: true });

    const gen = feed.generation;
    await writeFile(file, `${user('fresh')}\n`);
    await feed.update();
    assert.equal(feed.generation, gen + 1);
    assert.deepEqual(feed.entries.map((e) => [e.seq, e.id]), [[1, 'fresh']]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
