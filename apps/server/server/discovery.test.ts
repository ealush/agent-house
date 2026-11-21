import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaude, parseCodex, parseGemini, parseGrok, parseMuse, parseOpencode, promptTitle, spawnedOf } from './discovery.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test('claude transcript metadata', async () => {
  const t = await parseClaude(fixture('claude.jsonl'), 123);
  assert.deepEqual(t, { harness: 'claude', harnessId: 'claude', cwd: '/home/u/code/proj', title: 'Fix flaky login test', model: 'claude-opus-5-5', updatedAt: 123, file: fixture('claude.jsonl') });
});

test('claude transcript with an oversized image line stays discoverable', async () => {
  // A pasted screenshot rides inline as base64, so the line carrying the first
  // prompt can be larger than the head budget below and is cut mid-line there.
  const dir = await mkdtemp(join(tmpdir(), 'ah-claude-'));
  const file = join(dir, 'img-heavy.jsonl');
  const big = 'A'.repeat(700 * 1024);
  const lines = [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 'img-heavy' }),
    JSON.stringify({ parentUuid: null, isSidechain: false, promptId: 'p1', type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fix the image viewer' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }] } }),
    JSON.stringify({ parentUuid: 'x', isSidechain: false, type: 'attachment', userType: 'external', cwd: '/home/u/code/proj', sessionId: 'img-heavy' }),
    JSON.stringify({ parentUuid: 'y', isSidechain: false, type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'on it' }] } }),
  ];
  await writeFile(file, `${lines.join('\n')}\n`);
  const t = await parseClaude(file, 123);
  assert.equal(t?.harnessId, 'img-heavy');
  assert.equal(t?.cwd, '/home/u/code/proj');
  assert.equal(t?.title, 'fix the image viewer');
  assert.equal(t?.model, 'claude-opus-5-5');
});

test('claude transcript with a pathological single line still yields its prompt', async () => {
  // One line no budget can hold: only the prompt at its start is recovered.
  const dir = await mkdtemp(join(tmpdir(), 'ah-claude-'));
  const file = join(dir, 'huge-line.jsonl');
  const big = 'A'.repeat(9 * 1024 * 1024);
  const lines = [
    JSON.stringify({ parentUuid: null, isSidechain: false, promptId: 'p1', type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fix the image viewer' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }] } }),
    JSON.stringify({ parentUuid: 'x', isSidechain: false, type: 'attachment', userType: 'external', cwd: '/home/u/code/proj', sessionId: 'huge-line' }),
  ];
  await writeFile(file, `${lines.join('\n')}\n`);
  const t = await parseClaude(file, 123);
  assert.equal(t?.harnessId, 'huge-line');
  assert.equal(t?.cwd, '/home/u/code/proj');
  assert.equal(t?.title, 'fix the image viewer');
});

test('codex rollout metadata', async () => {
  const t = await parseCodex(fixture('codex.jsonl'), 456);
  assert.deepEqual(t, { harness: 'codex', harnessId: '0199-codex', cwd: '/home/u/code/proj', title: 'review PR 12', model: 'gpt-6.1-sol', updatedAt: 456, file: fixture('codex.jsonl') });
});

test('a codex thread the model spawned knows its parent, root, depth and name', async () => {
  const t = await parseCodex(fixture('codex-subagent.jsonl'), 456);
  assert.equal(t?.harnessId, '0199-child-a');
  assert.equal(t?.title, 'Map the API routes and report which ones lack tests.');
  assert.deepEqual(t?.spawned, { parentId: '0199-root', rootId: '0199-root', depth: 1, kind: 'spawn', nickname: 'Hilbert', role: 'explorer', bornAt: 1795127268 });
  // A conversation a person started is not spawned.
  assert.equal((await parseCodex(fixture('codex.jsonl'), 456))?.spawned, undefined);
});

test("a codex v2 thread is its own, not the parent's whose history it copies", async () => {
  // The parent's session_meta comes second, ahead of the parent's history: its id is not this thread's.
  const t = await parseCodex(fixture('codex-subagent-v2.jsonl'), 456);
  assert.equal(t?.harnessId, '0199-child-v2');
  assert.deepEqual(t?.spawned, { parentId: '0199-root', rootId: '0199-root', depth: 1, kind: 'spawn', nickname: 'Noether', historyStart: 5, bornAt: 1791497288 });
});

test('a thread the harness runs itself (a guardian review) is spawned, of the other kind', () => {
  const s = spawnedOf({ id: 'g1', session_id: 'r1', parent_thread_id: 'r1', source: { subagent: { other: 'guardian' } } });
  assert.deepEqual(s, { parentId: 'r1', rootId: 'r1', depth: 1, kind: 'other' });
  assert.equal(spawnedOf({ id: 'x', source: 'cli' }), undefined);
  assert.equal(spawnedOf({ id: 'x', source: { subagent: { thread_spawn: { parent_thread_id: '../etc' } } } }), undefined);
});

test('grok transcript metadata comes from summary.json', async () => {
  const t = await parseGrok(fixture('grok/chat_history.jsonl'), 123);
  assert.deepEqual(t, { harness: 'grok', harnessId: '019a-grok', cwd: '/home/u/code/proj', title: 'Fix the failing build', model: 'grok-4.5', updatedAt: Math.floor(Date.parse('2026-10-05T12:05:00.000Z') / 1000), file: fixture('grok/chat_history.jsonl') });
});

test('gemini transcript metadata, both file forms', async () => {
  const t = await parseGemini(fixture('gemini.jsonl'), 456);
  assert.deepEqual(t, { harness: 'gemini', harnessId: 'gemini-1', cwd: '/home/u/code/proj', title: 'Fix the parser', model: 'gemini-2.5-pro', updatedAt: 456, file: fixture('gemini.jsonl') });
  const legacy = await parseGemini(fixture('gemini-legacy.json'), 789);
  assert.equal(legacy?.harnessId, 'gemini-legacy');
  assert.equal(legacy?.title, 'Explain the retry logic');
  assert.equal(legacy?.cwd, ''); // the document form does not name directories
});

test('muse transcript metadata from the envelope records', async () => {
  const t = await parseMuse(fixture('muse.jsonl'), 321);
  assert.deepEqual(t, { harness: 'muse', harnessId: 'muse-1', cwd: '/home/u/code/proj', title: 'Fix the login redirect', model: 'muse-spark-1.2', updatedAt: 321, file: fixture('muse.jsonl'), birthAt: 1785972468 });
});

test('muse startup-only sessions stay discoverable with a fallback title', async () => {
  const t = await parseMuse(fixture('muse-startup.jsonl'), 999);
  assert.deepEqual(t, { harness: 'muse', harnessId: 'muse-new', cwd: '/home/u/code/proj', title: 'Muse session', model: undefined, updatedAt: 999, file: fixture('muse-startup.jsonl'), birthAt: 1785972468 });
});

test('muse approval sidecars without metadata are skipped', async () => {
  assert.equal(await parseMuse(fixture('muse-approval.jsonl'), 999), null);
});

test('opencode legacy tree metadata', async () => {
  const file = fixture('opencode/storage/session/proj1/ses_fixture1.json');
  const t = await parseOpencode(file, 111);
  assert.deepEqual(t, { harness: 'opencode', harnessId: 'ses_fixture1', cwd: '/home/u/code/proj', title: 'Fix the parser', model: 'gpt-5.1', updatedAt: 1759669500, file });
});

test('prompt titles skip injected context and keep the first line', () => {
  assert.equal(promptTitle('<system-reminder>x</system-reminder>'), null);
  assert.equal(promptTitle('/clear'), null);
  assert.equal(promptTitle('/plugin:skill args'), null);
  assert.equal(promptTitle('/home/u/.cache/ah/uploads/a.png /tmp/b.png fix this menu'), 'fix this menu', 'a prompt opened with an upload is a prompt');
  assert.equal(promptTitle('/home/u/.cache/ah/uploads/a.png'), 'a.png');
  assert.equal(promptTitle('\n  fix it\nmore'), 'fix it');
  assert.equal(promptTitle('x'.repeat(200))?.length, 88);
  assert.equal(promptTitle('\n\n<pasted_content id="e3ce">\n# Mission\nmore\n</pasted_content>'), '# Mission', 'a paste is a prompt');
});

test('titles drop paste placeholders and markup', async () => {
  const { cleanTitle } = await import('./discovery.ts');
  assert.equal(cleanTitle('[Image #1] working indicator is out of sync'), 'working indicator is out of sync');
  assert.equal(cleanTitle('fix this [Pasted text #2 +40 lines] please'), 'fix this please');
  assert.equal(cleanTitle('<command-name>/review</command-name> the diff'), '/review the diff');
  assert.equal(cleanTitle('[Image #1]'), '[Image #1]', 'nothing left: keep the raw text');
  assert.equal(cleanTitle('"/home/u/.cache/ah/uploads/2026-10-10T00-27-46-540Z-shot.png" why is this red?'), 'why is this red?');
  assert.equal(cleanTitle("'/home/u/.cache/ah/uploads/2026-10-10T00-27-46-540Z-my shot.png'"), 'my shot.png', 'quoted, with a space');
  assert.equal(cleanTitle('/home/u/.cache/ah/uploads/2026-10-10T00-27-46-540Z-shot.png'), 'shot.png', 'only an attachment: its name');
});
