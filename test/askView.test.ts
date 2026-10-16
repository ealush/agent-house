import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAsk } from '../web/askView.ts';

test('a screen-read command ask reads as its command and description, not the raw screen', () => {
  const p = readAsk({ kind: 'command', text: 'Bash command\n  pnpm test --filter auth -- --reporter=dot\n  Run the auth test suite\nDo you want to proceed?' } as any);
  assert.equal(p.kind, 'Wants to run a command');
  assert.equal(p.command, 'pnpm test --filter auth -- --reporter=dot');
  assert.equal(p.description, 'Run the auth test suite');
  assert.equal(p.question, undefined, 'the generic confirm is the kind line already');
  assert.match(p.context!, /Do you want to proceed\?/);
});

test("a hook's detail is the command exactly, even when the screen wrapped it", () => {
  const p = readAsk({ kind: 'command', text: 'Bash command\n  pnpm test --filter auth --\n  --reporter=dot\n  Run the auth test suite\nDo you want to proceed?' } as any, '$ pnpm test --filter auth -- --reporter=dot');
  assert.equal(p.command, 'pnpm test --filter auth -- --reporter=dot');
  assert.equal(p.description, 'Run the auth test suite', 'the wrapped tail is the command, not a description');
});

test('a hook-only command ask is the command', () => {
  const p = readAsk({ kind: 'command', text: 'rm -rf build' } as any);
  assert.equal(p.command, 'rm -rf build');
  assert.equal(p.context, undefined);
});

test('a tool ask leads with its question', () => {
  const p = readAsk({ kind: 'tool', text: 'Edit file\n src/app.tsx\nDo you want to make this edit to app.tsx?' } as any);
  assert.equal(p.question, 'Do you want to make this edit to app.tsx?');
  assert.match(p.context!, /src\/app\.tsx/);
});
