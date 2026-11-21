import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSession } from './review/owners.ts';
import type { SessionLite } from './review/service.ts';

const s = (uid: string, key: string, live: boolean): SessionLite => ({ uid, key, title: uid, agent: 'claude', status: live ? 'idle' : 'ended', cwd: '/p', branch: null, live });

test('the conversation, wherever it runs now, comes first', () => {
  // Resumed under a new uid: the stored uid is the old record's, ended.
  const sessions = [s('new', 'claude:c1', true), s('old', 'claude:c1', false)];
  assert.equal(resolveSession(sessions, 'claude:c1', 'old')?.uid, 'new');
});

test('a running session by uid beats an ended record of the conversation', () => {
  // The owner shown and the session dispatched to used to differ here: the view chose
  // the running session, dispatch the ended record (and so resumed a second copy).
  const sessions = [s('u1', 'claude:c2', true), s('u0', 'claude:c1', false)];
  assert.equal(resolveSession(sessions, 'claude:c1', 'u1')?.uid, 'u1');
});

test('nothing running: the conversation’s ended record, else the session’s', () => {
  const sessions = [s('u0', 'claude:c1', false), s('u1', 'claude:c9', false)];
  assert.equal(resolveSession(sessions, 'claude:c1', 'u1')?.uid, 'u0');
  assert.equal(resolveSession(sessions, 'claude:none', 'u1')?.uid, 'u1');
  assert.equal(resolveSession(sessions, null, 'u1')?.uid, 'u1');
});

test('an owner that names nothing, or nothing that exists, resolves to none', () => {
  const sessions = [s('u1', 'claude:c1', true)];
  assert.equal(resolveSession(sessions, null, null), null);
  assert.equal(resolveSession(sessions, 'claude:gone', 'gone'), null);
  // An empty key or uid never matches a session that has one.
  assert.equal(resolveSession([s('', '', true)], null, 'x'), null);
});
