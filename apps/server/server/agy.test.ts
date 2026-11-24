import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyArgs, agyMeta, fields, loadAgy } from './feed/adapters/agy.ts';
import { agyCatalog } from './catalog.ts';
import { modelSwitch } from './launch.ts';
import { DOC_ADAPTERS } from './feed/feed.ts';
import { agyAskedCommandStep, agyFixture, agyUserStep, writeAgyConversation } from '../test/agy.ts';

const fixture = agyFixture;

test('agy: a conversation reads as your messages, its thinking and replies, and each tool with its result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-agy-'));
  try {
    const file = writeAgyConversation(dir);
    const entries = (await loadAgy(file))!;
    assert.ok(entries, 'read');
    // Gemini's feed is agy's conversation (read as typed: feed.ts asTyped).
    assert.deepEqual(await DOC_ADAPTERS.gemini(file), entries, "Gemini's feed");
    const users = entries.filter((e) => e.role === 'user').map((e) => (e.parts[0] as any).text);
    assert.deepEqual(users, [
      'Read notes.txt, then run the shell command `echo done > out.txt`, then tell me in one line what notes.txt says.',
      'Reply with only the word ok.\nThis second line is part of the same message.',
      'Create hello.py that prints hi, then edit notes.txt to say "hello world", then run `cat missing.txt` (it will fail), then summarize in one line.',
      'Write a 400-word essay about tmux.',
    ]);
    // seq is the step's place in the conversation, and stays it as steps are rewritten.
    assert.deepEqual(entries.map((e) => e.seq), [...entries.map((e) => e.seq)].sort((a, b) => a - b));
    assert.equal(entries[0].seq, 1);
    assert.ok(entries.every((e) => e.at > Date.parse('2026-11-21') && e.at < Date.parse('2026-11-23')), 'each step carries its time');

    const first = entries.find((e) => e.role === 'assistant')!;
    assert.equal(first.parts[0].type, 'reasoning');
    const read = first.parts.find((p) => p.type === 'tool_call') as any;
    assert.equal(read.call.name, 'read_file');
    assert.equal(read.call.args.Path, '/home/me/proj/notes.txt');
    assert.equal(read.call.args.file_path, '/home/me/proj/notes.txt', 'the common name beside agy\'s own');

    const results = new Map(entries.flatMap((e) => e.parts).flatMap((p) => (p.type === 'tool_result' ? [[p.result.callId, p.result] as const] : [])));
    const calls = entries.flatMap((e) => e.parts).flatMap((p) => (p.type === 'tool_call' ? [p.call] : []));
    assert.deepEqual(calls.map((c) => c.name), ['read_file', 'run_command', 'write_file', 'edit_file', 'run_command']);
    for (const c of calls) assert.ok(results.has(c.id), `${c.name} has its result`);
    assert.equal(results.get(read.call.id)!.text, 'Showing lines 1-1 of 1\n1: hello', 'without the times agy heads it with');

    const [, echo, , edit, cat] = calls;
    assert.equal(echo.args.command, 'echo done > out.txt');
    assert.deepEqual(results.get(echo.id)!.data, { exitCode: 0 });
    assert.equal(results.get(echo.id)!.isError, false);
    assert.equal(edit.args.old_string, 'hello');
    assert.equal(edit.args.new_string, 'hello world');
    assert.equal(results.get(cat.id)!.isError, true, 'a command that exited 1 failed');
    assert.match(results.get(cat.id)!.text, /No such file or directory/);

    const replies = entries.filter((e) => e.role === 'assistant').flatMap((e) => e.parts).flatMap((p) => (p.type === 'text' ? [p.text] : []));
    assert.ok(replies.includes('ok'));
    assert.ok(replies.some((t) => t.startsWith('Created [hello.py](file:///home/me/proj/hello.py)')));
    // The reply stopped with Esc: what it had written, then that it was stopped.
    const stopped = entries.at(-1)!.parts;
    assert.ok(stopped[0].type === 'text' && stopped[0].text.startsWith('**The Quiet Power of tmux**'));
    assert.deepEqual(stopped.at(-1), { type: 'notice', kind: 'interrupted', text: 'Interrupted' });
    // agy's reminders to its own model are not the conversation.
    assert.ok(!JSON.stringify(entries).includes('work efficiently'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('agy: a tool still running shows no result yet; nothing to read is null, not an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-agy-'));
  try {
    // Up to the first command's call, with its run not answered yet (RUNNING, no result).
    const running = fixture.steps.slice(0, 5).map((s: any) => (s.idx === 4 ? { ...s, status: 2, payload: Buffer.from(stripResult(Buffer.from(s.payload, 'base64'))).toString('base64') } : s));
    const entries = (await loadAgy(writeAgyConversation(dir, fixture, running)))!;
    const calls = entries.flatMap((e) => e.parts).filter((p) => p.type === 'tool_call');
    const results = entries.flatMap((e) => e.parts).filter((p) => p.type === 'tool_result');
    assert.equal(calls.length, 2);
    assert.equal(results.length, 1, 'only the read has answered');
    assert.equal(await loadAgy(join(dir, 'missing.db')), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** The step without its generic run (field 140): a tool that hasn't finished. */
function stripResult(payload: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  for (const f of fields(payload)) {
    const start = i;
    // Re-walk to copy each field's bytes except 140's.
    const tagLen = varintLength(payload, i);
    const tag = readVarint(payload, i);
    i += tagLen;
    if (f.wire === 0) i += varintLength(payload, i);
    else if (f.wire === 2) {
      const len = readVarint(payload, i);
      i += varintLength(payload, i) + len;
    }
    if (Math.floor(tag / 8) !== 140) out.push(...payload.subarray(start, i));
  }
  return Uint8Array.from(out);
}
const varintLength = (b: Uint8Array, i: number) => {
  let n = 1;
  while (b[i + n - 1] >= 0x80) n++;
  return n;
};
const readVarint = (b: Uint8Array, i: number) => {
  let out = 0;
  let mul = 1;
  for (;;) {
    const c = b[i++];
    out += (c & 0x7f) * mul;
    if (c < 0x80) return out;
    mul *= 128;
  }
};

test('agy: a command it asked you about first stays in the conversation as what it asked and what came of it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-agy-'));
  try {
    const why = 'Running rsync with --delete to a remote host overwrites and deletes files there.';
    const at = Date.UTC(2026, 10, 24, 6, 37, 41);
    const steps = [agyUserStep(0, 'Sync it to the Mac', at), agyAskedCommandStep(1, 'call_1', 'rsync -az --delete ./ mac:~/code/', why, at + 1000), agyAskedCommandStep(2, 'call_2', 'rsync -az --delete ./ mac:~/code/', why, at + 2000, false)];
    const entries = (await loadAgy(writeAgyConversation(dir, fixture, steps)))!;
    const notices = entries.map((e) => e.parts.filter((p) => p.type === 'notice'));
    assert.deepEqual(notices[0], [], 'what you typed asks nothing');
    assert.deepEqual(notices[1], [{ type: 'notice', kind: 'info', text: `Asked to run this command, and you allowed it: ${why}` }]);
    assert.equal(entries[1].parts[0].type, 'tool_result', 'after what the command said');
    assert.deepEqual(notices[2], [{ type: 'notice', kind: 'info', text: `Asked to run this command, and it didn’t run: ${why}` }]);
    // The real conversation's tools ran without asking (agy's check approved them, or had none).
    const real = (await loadAgy(writeAgyConversation(dir, { ...fixture, id: 'real' })))!;
    assert.equal(real.flatMap((e) => e.parts).filter((p) => p.type === 'notice' && /^Asked/.test(p.text)).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agy: a conversation's folder and start come from its trajectory metadata", () => {
  const meta = agyMeta(Buffer.from(fixture.meta, 'base64'));
  assert.equal(meta.cwd, '/home/me/proj');
  assert.equal(new Date(meta.createdAt).toISOString(), '2026-11-21T23:36:01.998Z');
  assert.deepEqual(agyMeta(null), { cwd: null, createdAt: 0 });
});

test('agy: PascalCase arguments get the names the tool views read, never over one already there', () => {
  assert.deepEqual(agyArgs('{"CommandLine":"ls","toolSummary":"List"}'), { CommandLine: 'ls', toolSummary: 'List', command: 'ls', description: 'List' });
  assert.deepEqual(agyArgs('{"Path":"/a","path":"/b"}'), { Path: '/a', path: '/b', file_path: '/a' });
  assert.deepEqual(agyArgs('not json'), { input: 'not json' });
});

test('agy models: each model once, with the efforts it lists; your /model pick is the default', () => {
  const list = [
    'Fetching available models...',
    'gemini-4-neon-high\tGemini 4 Neon (High)',
    'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
    'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
    'gemini-4-neon-low\tGemini 4 Neon (Low)',
    'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
    'gemini-4-argon-high\tGemini 4 Argon (High)',
    'gemini-4-argon-low\tGemini 4 Argon (Low)',
    'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
    'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  ].join('\n');
  const cat = agyCatalog(list, 'Gemini 4 Neon (Low)');
  assert.deepEqual(
    cat.models.map((m) => [m.id, m.name, m.efforts]),
    [
      ['gemini-4-neon', 'Gemini 4 Neon', ['low', 'medium', 'high', 'xhigh']],
      ['gemini-4-argon', 'Gemini 4 Argon', ['low', 'medium', 'high']],
      ['gemini-pro-orchestrator-neon', 'Orchestrator (Neon)', []],
      ['claude-opus-5-5', 'Claude Opus 5.5', ['high']],
      ['gpt-oss-120b', 'GPT-OSS 120B', ['medium']],
    ],
  );
  assert.deepEqual(cat.models[0].args, ['--model', 'gemini-4-neon']);
  assert.equal(cat.defaultModel, 'gemini-4-neon');
  assert.equal(cat.defaultEffort, 'low');
  assert.equal(agyCatalog(list).defaultModel, undefined, 'nothing picked yet: agy decides');
  assert.deepEqual(agyCatalog('').models, []);
});

test('a model switch that names its effort keeps the session at its effort, or the nearest one below', () => {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  const neon = { id: 'gemini-4-neon', name: 'Gemini 4 Neon', args: [], efforts: ['low', 'medium', 'high', 'xhigh'] };
  const argon = { id: 'gemini-4-argon', name: 'Gemini 4 Argon', args: [], efforts: ['low', 'medium', 'high'] };
  const orchestrator = { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator', args: [], efforts: [] };
  const t = '/model {model}-{effort}';
  assert.deepEqual(modelSwitch(t, neon, 'high', levels), { text: '/model gemini-4-neon-high', effort: 'high' });
  assert.deepEqual(modelSwitch(t, argon, 'xhigh', levels), { text: '/model gemini-4-argon-high', effort: 'high' });
  assert.deepEqual(modelSwitch(t, argon, null, levels), { text: '/model gemini-4-argon-medium', effort: 'medium' });
  assert.deepEqual(modelSwitch(t, orchestrator, 'high', levels), { text: '/model gemini-pro-orchestrator-neon' });
  // A template without the slot is typed as before.
  assert.deepEqual(modelSwitch('/model {model}', neon, 'high', levels), { text: '/model gemini-4-neon' });
});
