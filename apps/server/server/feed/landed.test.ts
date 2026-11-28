import '../../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conversationAnswered, conversationHas, markConversation, needleFor } from './landed.ts';
import { agyFixture, agyReplyStep, agyUserStep, writeAgyConversation } from '../../test/agy.ts';

const user = (content: string) => JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content } }) + '\n';

test('a message is found in a line transcript after the mark only, however its words are wrapped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-landed-'));
  try {
    const file = join(dir, 't.jsonl');
    const said = 'The workspaces 1-9 isn’t "very" useful\nsecond line';
    writeFileSync(file, user('before'));
    const mark = await markConversation('claude', file);
    assert.equal(await conversationHas(mark, file, said), false, 'nothing after the mark');
    appendFileSync(file, user('The workspaces 1-9  isn’t "very"\nuseful\nsecond line'));
    assert.equal(await conversationHas(mark, file, said), true);
    assert.equal(await conversationHas(mark, file, 'before'), false, 'what came before the mark is not it');
    assert.equal(await conversationHas({ ...mark, size: 1 << 30 }, file, said), true, 'a rewritten file: never typed twice');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("words the agent only read (a tool's output) are not the user saying them", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-landed-'));
  try {
    const file = join(dir, 't.jsonl');
    writeFileSync(file, '');
    const mark = await markConversation('claude', file);
    const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Write the spec and then build it' }] } };
    appendFileSync(file, JSON.stringify(result) + '\n');
    assert.equal(await conversationHas(mark, file, 'Write the spec and then build it'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gemini's message is found in Antigravity's SQLite store, after the mark only", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-landed-'));
  try {
    const at = Date.now();
    const file = writeAgyConversation(dir, agyFixture, [agyUserStep(0, 'Count from 1 to 3.', at - 60_000), agyReplyStep(1, '1 2 3', at - 59_000)]);
    const mark = await markConversation('gemini', file);
    assert.equal(mark.seq, 2);
    assert.equal(await conversationHas(mark, file, 'Write the spec and then build it'), false, 'still in the box');
    const sent = agyUserStep(2, 'Write the spec and then build it', at + 500);
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)').run(sent.idx, sent.type, sent.status, Buffer.from(sent.payload, 'base64'));
    db.close();
    assert.equal(await conversationHas(mark, file, 'Write the spec and then build it'), true);
    assert.equal(await conversationHas(mark, file, 'Count from 1 to 3.'), false, 'what came before the mark is not it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gemini's message is found though older replies stopped showing meanwhile (agy compacts them)", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-landed-'));
  try {
    const at = Date.now();
    const file = writeAgyConversation(dir, agyFixture, [agyUserStep(0, 'Count from 1 to 3.', at - 60_000), agyReplyStep(1, '1 2 3', at - 59_000), agyReplyStep(2, 'Done.', at - 58_000)]);
    const mark = await markConversation('gemini', file);
    const db = new DatabaseSync(file);
    // Both replies blanked (they render nothing now), then the message and the agent's
    // answers to it: as many entries as at the mark, the message no longer past that count.
    for (const idx of [1, 2]) db.prepare('UPDATE steps SET step_payload = ? WHERE idx = ?').run(Buffer.from(agyReplyStep(idx, '', at).payload, 'base64'), idx);
    for (const step of [agyUserStep(3, 'Should it be another harness?', at + 500), agyReplyStep(4, 'Looking.', at + 600), agyReplyStep(5, 'It should.', at + 700)]) {
      db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)').run(step.idx, step.type, step.status, Buffer.from(step.payload, 'base64'));
    }
    db.close();
    assert.equal(await conversationHas(mark, file, 'Should it be another harness?'), true);
    assert.equal(await conversationHas(mark, file, 'Count from 1 to 3.'), false, 'what came before the mark is not it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new session's first prompt is found in the conversation its agent writes after it", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-landed-'));
  try {
    const mark = await markConversation('claude', null);
    const file = join(dir, 't.jsonl');
    writeFileSync(file, user('kickoff the work'));
    assert.equal(await conversationHas(mark, file, 'kickoff the work'), true);
    assert.equal(await conversationHas({ ...mark, at: Date.now() + 60_000 }, file, 'kickoff the work'), false, 'written well before the send: not this one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new session's first prompt is found in a transcript that stamps no times (Grok)", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-landed-'));
  try {
    // Sent before the agent had a conversation to write it in: no file at the mark.
    const mark = await markConversation('grok', null);
    const file = join(dir, 'chat_history.jsonl');
    const grokUser = (text: string, i: number) => JSON.stringify({ type: 'user', content: [{ type: 'text', text: `<user_query>${text}</user_query>` }], prompt_index: i }) + '\n';
    writeFileSync(file, grokUser('Reply with exactly the word PONG1 and nothing else.', 0));
    assert.equal(await conversationHas(mark, file, 'Reply with exactly the word PONG1 and nothing else.'), true);
    assert.equal(await conversationHas(mark, file, 'something never said'), false, 'still only what it says');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pasted screenshot path is no way to find a prompt: agents swap it for their own token', () => {
  const text = '/home/me/.cache/ah/uploads/a-paste.png /home/me/.cache/ah/uploads/b-paste.png We gotta be able to collapse the queue';
  assert.equal(needleFor(text), 'Wegottabeabletocollapsethequeue');
  assert.equal(needleFor('first\nthe "longest" line of the prompt'), 'the"longest"lineoftheprompt');
  assert.equal(needleFor('/home/me/shot.png'), null, 'only a path: nothing to tell it by');
});

test('a message is answered once the agent says or does anything after it; stopped first, it is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-landed-'));
  try {
    const file = join(dir, 't.jsonl');
    writeFileSync(file, user('before'));
    const mark = await markConversation('claude', file);
    assert.equal(await conversationAnswered(mark, file, 'look at the logs'), false, 'not there');
    appendFileSync(file, user('look at the logs'));
    assert.equal(await conversationAnswered(mark, file, 'look at the logs'), false, 'there, stopped before a word');
    appendFileSync(file, user('something else'));
    assert.equal(await conversationAnswered(mark, file, 'look at the logs'), false, "the next message isn't its answer");
    appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }) + '\n');
    assert.equal(await conversationAnswered(mark, file, 'look at the logs'), true, 'a tool call is an answer begun');
    assert.equal(await conversationAnswered({ ...mark, size: 1 << 30 }, file, 'look at the logs'), true, "can't tell: never typed twice");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
