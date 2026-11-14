import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LastReplies, lastSaid, plain, readLastSaid } from './replies.ts';
import type { Entry } from './feed/schema.ts';

const at = '2026-11-14T12:00:00.000Z';
const said = (role: 'user' | 'assistant', text: string) => JSON.stringify({ type: role, uuid: `${role}-${text.length}`, timestamp: at, message: { role, content: role === 'user' ? text : [{ type: 'text', text }] } });
const tool = () =>
  JSON.stringify({ type: 'assistant', uuid: 'tu', timestamp: at, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git push -q mac origin/main' } }] } }) +
  '\n' +
  JSON.stringify({ type: 'user', uuid: 'tr', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] } });

test('a preview is plain words: no Markdown marks, code blocks or runs of whitespace', () => {
  assert.equal(plain('## Done\n\n**Back** to `two` queries, see [the PR](https://x/1).\n\n```ts\nconst a = 1\n```\n- one\n- two'), 'Done Back to two queries, see the PR. one two');
  assert.equal(plain('x'.repeat(400)).length, 300);
  assert.ok(plain('x'.repeat(400)).endsWith('…'));
  assert.equal(plain('snake_case_name stays'), 'snake_case_name stays');
});

test('the last thing said skips tools, results and harness wrappers', () => {
  const e = (role: Entry['role'], parts: Entry['parts']): Entry => ({ seq: 0, id: '', role, step: 'message', at: 5, parts });
  assert.deepEqual(
    lastSaid([e('user', [{ type: 'text', text: 'fix it' }]), e('assistant', [{ type: 'text', text: 'Fixed **it**.' }]), e('assistant', [{ type: 'tool_call', call: { id: 'c', name: 'Bash', args: {} } }]), e('tool', [{ type: 'tool_result', result: { callId: 'c', text: 'ok', isError: false } }])]),
    { role: 'assistant', text: 'Fixed it.', at: 5 },
  );
  assert.deepEqual(lastSaid([e('assistant', [{ type: 'text', text: 'Earlier.' }]), e('user', [{ type: 'text', text: 'and now this' }])]), { role: 'user', text: 'and now this', at: 5 }, 'working on your message: that is the last thing said');
  assert.deepEqual(lastSaid([e('assistant', [{ type: 'text', text: 'Real reply.' }]), e('user', [{ type: 'text', text: '<local-command-stdout>Set model</local-command-stdout>' }])]), { role: 'assistant', text: 'Real reply.', at: 5 }, 'a command’s output is nobody’s message');
  assert.equal(lastSaid([e('assistant', [{ type: 'reasoning', text: 'hmm' }])]), null, 'thinking is not a reply');
  assert.equal(lastSaid([]), null);
});

test('read from the end of a real Claude Code transcript, even starting mid-line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-replies-'));
  const file = join(dir, 's.jsonl');
  const filler = said('assistant', 'old '.repeat(20_000)); // pushes the start of the file out of the tail
  await writeFile(file, [said('user', 'first'), filler, filler, filler, said('user', 'check the p95 numbers'), said('assistant', 'Back to two queries and **p95 176 ms**.'), tool(), ''].join('\n'));
  const { size } = await import('node:fs/promises').then((fs) => fs.stat(file));
  assert.deepEqual(await readLastSaid(file, size, 'claude'), { role: 'assistant', text: 'Back to two queries and p95 176 ms.', at: Date.parse(at) });
  assert.equal(await readLastSaid(file, size, 'nope'), null, 'no line adapter: nothing');
});

test('each session is read again only when its transcript grows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-replies-'));
  const file = join(dir, 's.jsonl');
  await writeFile(file, said('assistant', 'One.') + '\n');
  const replies = new LastReplies();
  assert.equal(replies.peek('u1'), null, 'nothing until read');
  assert.equal(await replies.refresh([{ uid: 'u1', file, adapter: 'claude' }]), true);
  assert.equal(replies.peek('u1')?.text, 'One.');
  assert.equal(await replies.refresh([{ uid: 'u1', file, adapter: 'claude' }]), false, 'same size: not read again');
  await appendFile(file, said('user', 'and two?') + '\n');
  assert.equal(await replies.refresh([{ uid: 'u1', file, adapter: 'claude' }]), true);
  assert.deepEqual(replies.peek('u1'), { role: 'user', text: 'and two?', at: Date.parse(at) });
  await replies.refresh([]);
  assert.equal(replies.peek('u1'), null, 'a session that is gone is forgotten');
});

test('a session that just finished is read at once, the others left as they are', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-replies-'));
  const a = join(dir, 'a.jsonl');
  const b = join(dir, 'b.jsonl');
  await writeFile(a, said('user', 'fix it') + '\n');
  await writeFile(b, said('assistant', 'Other.') + '\n');
  const replies = new LastReplies();
  await replies.refresh([{ uid: 'a', file: a, adapter: 'claude' }, { uid: 'b', file: b, adapter: 'claude' }]);
  await appendFile(a, said('assistant', 'Fixed it.') + '\n');
  await replies.readNow([{ uid: 'a', file: a, adapter: 'claude' }]);
  assert.equal(replies.peek('a')?.text, 'Fixed it.', 'its answer, without waiting for the next pass');
  assert.equal(replies.peek('b')?.text, 'Other.', 'a session not asked about is kept');
});
