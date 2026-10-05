import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeLine } from './feed/adapters/claude.ts';
import { parseCodexLine } from './feed/adapters/codex.ts';
import { textParts, clip } from './feed/parts.ts';
import { TranscriptFeed, ADAPTERS } from './feed/feed.ts';

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
