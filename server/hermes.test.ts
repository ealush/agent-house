import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadHermes } from './feed/adapters/hermes.ts';

// The two tables the adapter reads, trimmed to the columns it uses.
function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'ah-hermes-')), 'state.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, title TEXT, display_name TEXT, model TEXT, started_at REAL, last_activity_at REAL, parent_session_id TEXT, hidden INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, timestamp REAL, reasoning TEXT, display_kind TEXT);`);
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run('s1', 'cli', '/work/app', 'Fix the build', null, 'grok-4.7', 100, 200, null, 0);
  const add = db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, timestamp, reasoning, display_kind) VALUES (?,?,?,?,?,?,?,?)');
  add.run('s1', 'system', 'You are Hermes', null, null, 100, null, null);
  add.run('s1', 'user', 'why is the build red?', null, null, 101, null, null);
  add.run('s1', 'assistant', '', JSON.stringify([{ id: 'c1', function: { name: 'terminal', arguments: '{"command":"pnpm build"}' } }]), null, 102, 'Run it first.', null);
  add.run('s1', 'tool', JSON.stringify({ output: 'error TS2304', exit_code: 2 }), null, 'c1', 103, null, null);
  add.run('s1', 'assistant', 'A missing import.', null, null, 104, null, null);
  add.run('s1', 'user', 'internal nudge', null, null, 105, null, 'hidden');
  db.close();
  return path;
}

test('Hermes messages become feed entries: text, reasoning, tool call and its result', async () => {
  const entries = (await loadHermes(`${fixture()}#s1`))!;
  assert.deepEqual(entries.map((e) => e.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.deepEqual(entries[0].parts, [{ type: 'text', text: 'why is the build red?' }]);
  assert.equal(entries[1].parts[0].type, 'reasoning');
  assert.deepEqual(entries[1].parts[1], { type: 'tool_call', call: { id: 'c1', name: 'terminal', args: { command: 'pnpm build' } } });
  const result = entries[2].parts[0] as any;
  assert.equal(result.result.callId, 'c1');
  assert.equal(result.result.text, 'error TS2304');
  assert.equal(result.result.isError, true);
  assert.equal(entries[1].at, 102_000);
});

test('a missing database is no transcript, not an error', async () => {
  assert.equal(await loadHermes('/nope/state.db#s1'), null);
});
