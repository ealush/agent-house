import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePiLine, providerError } from './feed/adapters/pi.ts';
import { ADAPTERS, TranscriptFeed } from './feed/feed.ts';
import { conversationHas, markConversation } from './feed/landed.ts';
import { discoverPi, parsePi } from './discovery.ts';
import { PI_LEVELS, piCatalog } from './catalog.ts';
import { extract } from './portable/extract.ts';
import { DEFAULT_PRESETS } from './config.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/pi.jsonl', import.meta.url));
const lines = async () => (await readFile(FIXTURE, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const entries = async () => (await lines()).map((d, i) => parsePiLine(d, i + 1)).filter((e) => !!e);

test('pi: a session reads as your messages, its replies, and each tool call with its result', async () => {
  const all = await entries();
  // The header, model and thinking changes, the system prompt and the name aren't messages.
  assert.equal(all[0].role, 'user');
  const users = all.filter((e) => e.role === 'user').map((e) => e.parts.filter((p) => p.type === 'text').map((p: any) => p.text).join(''));
  assert.deepEqual(users, ['hello there', 'RUN echo spike-ok', 'RUN echo survived', 'SLOW please', 'RUN echo from-tui', 'Fix the typo in README']);
  assert.equal((all[1].parts[0] as any).text, 'You said: hello there');

  const call = all.find((e) => e.parts.some((p) => p.type === 'tool_call' && p.call.name === 'bash'))!;
  assert.equal(call.step, 'tool_execution');
  const id = (call.parts[0] as any).call.id;
  assert.deepEqual((call.parts[0] as any).call.args, { command: 'echo spike-ok' });
  const result = all.find((e) => e.role === 'tool' && (e.parts[0] as any).result.callId === id)!;
  assert.equal((result.parts[0] as any).result.text, 'spike-ok\n');
  assert.equal((result.parts[0] as any).result.isError, false);
  // A call you denied is an error result.
  const denied = all.find((e) => e.role === 'tool' && (e.parts[0] as any).result.text === 'Not approved')!;
  assert.equal((denied.parts[0] as any).result.isError, true);
});

test('pi: Stop and a provider error end a turn with a notice', async () => {
  const all = await entries();
  const stopped = all.find((e) => e.parts.some((p) => p.type === 'notice' && p.kind === 'interrupted'))!;
  assert.equal((stopped.parts[0] as any).text, 'tick tick tick tick');
  const failed = all.find((e) => e.parts.some((p) => p.type === 'notice' && p.text.includes('quota')))!;
  assert.equal(failed.role, 'assistant');
  assert.ok(all.some((e) => e.parts.some((p) => p.type === 'notice' && p.kind === 'compacted')), 'compaction');
});

test("pi: an edit reads under the names the chat's diff view reads; a picture and thinking come through", async () => {
  const all = await entries();
  const edit = all.find((e) => e.parts.some((p) => p.type === 'tool_call' && p.call.name === 'edit'))!;
  assert.deepEqual(edit.parts.map((p) => p.type), ['reasoning', 'text', 'tool_call']);
  const args = (edit.parts[2] as any).call.args;
  assert.equal(args.file_path, 'README.md');
  assert.equal(args.old_string, 'teh');
  assert.equal(args.new_string, 'the');
  const asked = all.find((e) => e.role === 'user' && e.parts.some((p) => p.type === 'media'))!;
  assert.match((asked.parts[1] as any).src, /^data:image\/png;base64,/);
  // `!git diff --stat` typed in pi's editor is a command with its output.
  const typed = all.find((e) => e.parts.some((p) => p.type === 'tool_call' && (p.call.args as any).command === 'git diff --stat'))!;
  assert.equal((typed.parts[1] as any).result.text, ' README.md | 2 +-\n');
});

test("pi: its feed is the session file, and a message you send is found there once it's in", async () => {
  assert.equal(DEFAULT_PRESETS.find((p) => p.id === 'pi')?.feed, 'pi');
  assert.ok(ADAPTERS.pi, 'registered');
  const feed = new TranscriptFeed(FIXTURE, ADAPTERS.pi);
  await feed.update();
  assert.deepEqual(feed.entries.map((e) => e.id), (await entries()).map((e) => e.id));
  // Delivery is confirmed from the transcript (landed.ts), as for the other line adapters.
  const dir = await mkdtemp(join(tmpdir(), 'ah-pi-'));
  try {
    const file = join(dir, 's.jsonl');
    await copyFile(FIXTURE, file);
    const mark = (await markConversation('pi', file))!;
    assert.equal(await conversationHas(mark, file, 'a new message'), false);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, JSON.stringify({ type: 'message', id: 'n1', parentId: 'aa000008', timestamp: '2026-11-27T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'a new message' }], timestamp: 1 } }) + '\n');
    assert.equal(await conversationHas(mark, file, 'a new message'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pi: History finds its sessions, named by /name or the first prompt, with the model last chosen', async () => {
  const t = (await parsePi(FIXTURE, 100))!;
  assert.equal(t.harness, 'pi');
  assert.equal(t.harnessId, '0198c1a2-pi-fixture');
  assert.equal(t.cwd, '/home/u/code/app');
  assert.equal(t.title, 'README typo');
  assert.equal(t.model, 'google/gemini-3.8-flash');
  const dir = await mkdtemp(join(tmpdir(), 'ah-pi-'));
  try {
    await mkdir(join(dir, '--home-u-code-app--'));
    await copyFile(FIXTURE, join(dir, '--home-u-code-app--', '2026-11-27T09-25-26-149Z_0198c1a2-pi-fixture.jsonl'));
    const found = await discoverPi(dir);
    assert.deepEqual(found.map((x) => x.harnessId), ['0198c1a2-pi-fixture']);
    assert.deepEqual(await discoverPi(join(dir, 'missing')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pi: its models are the ones --list-models prints, as provider/id, with thinking levels where it reasons", () => {
  const list = [
    'provider  model                         context  max-out  thinking  images',
    'google    gemini-3.8-flash              1.0M     65.5K    yes       yes   ',
    'groq      llama-3.3-70b-versatile       131.1K   32.8K    no        no    ',
    'groq      openai/gpt-oss-120b           131.1K   65.5K    yes       no    ',
    '',
  ].join('\n');
  const c = piCatalog(list, { defaultProvider: 'google', defaultModel: 'gemini-3.8-flash', defaultThinkingLevel: 'high' });
  assert.deepEqual(c.models.map((m) => m.id), ['google/gemini-3.8-flash', 'groq/llama-3.3-70b-versatile', 'groq/openai/gpt-oss-120b']);
  assert.deepEqual(c.models[0].args, ['--model', 'google/gemini-3.8-flash']);
  assert.deepEqual(c.models[0].efforts, PI_LEVELS);
  assert.deepEqual(c.models[1].efforts, []);
  assert.equal(c.defaultModel, 'google/gemini-3.8-flash');
  assert.equal(c.defaultEffort, 'high');
  // A saved pick it no longer lists, or nothing signed in, gives no default.
  assert.equal(piCatalog(list, { defaultProvider: 'openai', defaultModel: 'gone' }).defaultModel, undefined);
  assert.deepEqual(piCatalog('No models available.\n', null).models, []);
});

test('pi: a session moves to another agent with its messages, model and folder', async () => {
  const doc = await extract({ host: 'h', harness: 'pi', adapter: 'pi', harnessId: '0198c1a2-pi-fixture', file: FIXTURE });
  assert.equal(doc.cwd, '/home/u/code/app');
  assert.deepEqual(doc.models, ['fake-1', 'gemini-3.8-flash']);
  assert.equal(doc.messages.find((m) => m.role === 'assistant')?.model, 'fake-1');
  assert.ok(doc.messages.some((m) => m.role === 'user' && JSON.stringify(m.parts).includes('Fix the typo in README')));
});

test("pi: a provider's refusal reads as what it said, not its JSON", () => {
  assert.equal(
    providerError('429: {"message":"Rate limit reached for model `openai/gpt-oss-20b` in organization `org_1`. Please try again in 19s.","type":"tokens","code":"rate_limit_exceeded"}'),
    '429: Rate limit reached for model `openai/gpt-oss-20b` in organization `org_1`. Please try again in 19s.',
  );
  assert.equal(providerError('400 {"error":{"message":"API key not valid.","status":"INVALID_ARGUMENT"}}'), '400: API key not valid.');
  assert.equal(providerError('Operation aborted'), 'Operation aborted');
  assert.equal(providerError('500: {not json'), '500: {not json');
  assert.equal(providerError(''), 'The model returned an error');
});
