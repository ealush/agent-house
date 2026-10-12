import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseClaude, parseCodex, parseGemini, parseGrok, parseMuse, parseOpencode, promptTitle } from './discovery.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test('claude transcript metadata', async () => {
  const t = await parseClaude(fixture('claude.jsonl'), 123);
  assert.deepEqual(t, { harness: 'claude', harnessId: 'claude', cwd: '/home/u/code/proj', title: 'Fix flaky login test', model: 'claude-opus-5-5', updatedAt: 123, file: fixture('claude.jsonl') });
});

test('codex rollout metadata', async () => {
  const t = await parseCodex(fixture('codex.jsonl'), 456);
  assert.deepEqual(t, { harness: 'codex', harnessId: '0199-codex', cwd: '/home/u/code/proj', title: 'review PR 12', model: 'gpt-6.1-sol', updatedAt: 456, file: fixture('codex.jsonl') });
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
  assert.equal(promptTitle('\n  fix it\nmore'), 'fix it');
  assert.equal(promptTitle('x'.repeat(200))?.length, 88);
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
