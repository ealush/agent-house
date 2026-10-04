import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseClaude, parseCodex, promptTitle } from './discovery.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test('claude transcript metadata', async () => {
  const t = await parseClaude(fixture('claude.jsonl'), 123);
  assert.deepEqual(t, { harness: 'claude', harnessId: 'claude', cwd: '/home/u/code/proj', title: 'Fix flaky login test', model: 'claude-opus-5-5', updatedAt: 123 });
});

test('codex rollout metadata', async () => {
  const t = await parseCodex(fixture('codex.jsonl'), 456);
  assert.deepEqual(t, { harness: 'codex', harnessId: '0199-codex', cwd: '/home/u/code/proj', title: 'review PR 12', model: 'gpt-6.1-sol', updatedAt: 456 });
});

test('prompt titles skip injected context and keep the first line', () => {
  assert.equal(promptTitle('<system-reminder>x</system-reminder>'), null);
  assert.equal(promptTitle('/clear'), null);
  assert.equal(promptTitle('\n  fix it\nmore'), 'fix it');
  assert.equal(promptTitle('x'.repeat(200))?.length, 88);
});
