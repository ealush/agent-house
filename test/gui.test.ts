import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Entry } from '../server/feed/schema.ts';
import { initialFeed, project, reduce } from '../web/gui/reducer.ts';
import { patchLines, structuredLines } from '../web/gui/diff.ts';

const user = (seq: number, text: string): Entry => ({ seq, id: `u${seq}`, role: 'user', step: 'message', at: seq, parts: [{ type: 'text', text }] });
const call = (seq: number, id: string): Entry => ({ seq, id: `c${seq}`, role: 'assistant', step: 'tool_execution', at: seq, parts: [{ type: 'tool_call', call: { id, name: 'Bash', args: {} } }] });
const result = (seq: number, callId: string): Entry => ({ seq, id: `r${seq}`, role: 'tool', step: 'observation', at: seq, parts: [{ type: 'tool_result', result: { callId, text: 'ok', isError: false } }] });
const say = (seq: number, text: string): Entry => ({ seq, id: `a${seq}`, role: 'assistant', step: 'llm_call', at: seq, parts: [{ type: 'text', text }] });

const snapshot = (entries: Entry[], reason: 'initial' | 'rotated' = 'initial') =>
  ({ type: 'snapshot', reason, harness: 'claude', entries, floor: 0, head: entries.at(-1)?.seq ?? 0, hasOlder: false }) as const;

test('appends dedupe by seq and keep order; results fold in by call id', () => {
  let s = reduce(initialFeed, snapshot([user(1, 'hi'), call(2, 't1')]));
  assert.equal(s.status, 'live');
  assert.equal(s.results.t1, undefined);
  s = reduce(s, { type: 'append', entries: [call(2, 't1'), result(3, 't1')], head: 3 });
  assert.deepEqual(s.entries.map((e) => e.seq), [1, 2, 3]);
  assert.equal(s.results.t1.text, 'ok');
});

test('older pages merge in front; a reconnect snapshot is not a rebuild, a rotation is', () => {
  let s = reduce(initialFeed, { ...snapshot([say(10, 'x')]), hasOlder: true });
  s = reduce(s, { type: 'older', entries: [user(5, 'a'), user(7, 'b')], hasOlder: false });
  assert.deepEqual(s.entries.map((e) => e.seq), [5, 7, 10]);
  assert.equal(s.hasOlder, false);
  const epoch = s.epoch;
  assert.equal(reduce(s, snapshot([say(10, 'x')])).epoch, epoch);
  const rotated = reduce(s, snapshot([user(1, 'new')], 'rotated'));
  assert.equal(rotated.epoch, epoch + 1);
  assert.deepEqual(rotated.entries.map((e) => e.seq), [1]);
});

test('projection: agent turns group text and consecutive tool calls; results never show alone', () => {
  const blocks = project([user(1, 'go'), say(2, 'on it'), call(3, 'a'), result(4, 'a'), call(5, 'b'), say(6, 'done'), user(7, 'thanks')]);
  assert.deepEqual(
    blocks.map((b) => (b.kind === 'agent' ? b.items.map((i) => (i.kind === 'tools' ? `tools:${i.calls.map((c) => c.id).join(',')}` : i.part.type)) : b.kind)),
    ['user', ['text', 'tools:a,b', 'text'], 'user'],
  );
});

test('diffs: codex patches and claude structured hunks number lines from the new file', () => {
  const lines = patchLines('*** Begin Patch\n*** Update File: a.ts\n@@ -3,2 +3,2 @@\n ctx\n-old\n+new\n*** End Patch');
  assert.deepEqual(lines.map((l) => [l.kind, l.text, l.n]), [
    ['file', 'a.ts', null],
    ['hunk', '…', null],
    ['ctx', 'ctx', 3],
    ['del', 'old', 4],
    ['add', 'new', 4],
  ]);
  assert.deepEqual(structuredLines([{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+c'] }])!.map((l) => l.n), [null, 1, 2, 2]);
  assert.equal(structuredLines('nope'), null);
});
