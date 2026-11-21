// A session is addressed by its uid everywhere (spec FND-4): the window routes (rename,
// terminate, capture, changes, branches, pull request, side chat) answer under
// /api/sessions/:uid too, resolved to whichever window the session has now.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startAh, cleanup, http, signIn, until, type Ah } from './helpers.ts';

let ah: Ah;
let cookie: string;

before(async () => {
  ah = await startAh();
  cookie = await signIn(ah);
});
after(() => cleanup(ah));

test('rename, capture and terminate by session uid', async () => {
  const created = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files`, label: 'by-uid' } });
  assert.equal(created.status, 201, created.body);
  const { id, uid } = created.json();
  await until(async () => (await http(ah, 'GET', '/api/state', { cookie })).json().windows.some((w: { uid: string }) => w.uid === uid), 8000, 'session in state');

  const renamed = await http(ah, 'PUT', `/api/sessions/${uid}/name`, { cookie, body: { name: 'renamed by uid' } });
  assert.equal(renamed.status, 200, renamed.body);
  assert.equal(ah.tmux('display-message', '-p', '-t', id, '#{window_name}').trim(), 'renamed by uid');

  const capture = await http(ah, 'GET', `/api/sessions/${uid}/capture?lines=10`, { cookie });
  assert.equal(capture.status, 200, capture.body);

  // The side chat and the subscription it uses, by uid as well.
  assert.equal((await http(ah, 'GET', `/api/sessions/${uid}/chat`, { cookie })).status, 200);
  const picked = await http(ah, 'PUT', `/api/sessions/${uid}/chat/subscription`, { cookie, body: { id: 'none-yet' } });
  assert.match(picked.body, /subscription not found/); // reached the chat route, which knows no such subscription

  // The verb belongs to the action: renaming takes PUT, terminating POST.
  assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/name`, { cookie, body: { name: 'x' } })).status, 405);
  assert.equal((await http(ah, 'DELETE', `/api/sessions/${uid}/terminate`, { cookie })).status, 405);

  const killed = await http(ah, 'POST', `/api/sessions/${uid}/terminate`, { cookie });
  assert.equal(killed.status, 200, killed.body);
  await until(() => !ah.tmux('list-windows', '-a', '-F', '#{window_id}').split('\n').includes(id), 8000, 'window gone');

  // A session that isn't running has no window to act on.
  const gone = await http(ah, 'GET', `/api/sessions/${uid}/capture`, { cookie });
  assert.equal(gone.status, 404);
  assert.match(gone.body, /isn't running|window not found/);
});

test('a send retried with the same id is typed once', async () => {
  const created = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files`, label: 'retry' } });
  assert.equal(created.status, 201, created.body);
  const { uid } = created.json();
  await until(async () => (await http(ah, 'GET', '/api/state', { cookie })).json().windows.some((w: { uid: string }) => w.uid === uid), 8000, 'session in state');
  const log = `${ah.dir}/files/typed.log`;
  const say = (id: string | undefined) => http(ah, 'POST', `/api/sessions/${uid}/send`, { cookie, body: { text: `echo said >> ${log}`, ...(id ? { id } : {}) } });
  const lines = () => {
    try {
      return readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const first = await say('msg-1');
  assert.equal(first.status, 200, first.body);
  assert.equal(first.json().outcome, 'delivered');
  await until(() => lines() === 1, 8000, 'typed');
  // The answer was lost; the phone asks again with the same id.
  const retry = await say('msg-1');
  assert.equal(retry.status, 200, retry.body);
  assert.equal(retry.json().outcome, 'delivered');
  // A new message (another id, or none) is a new message.
  await say('msg-2');
  await until(() => lines() === 2, 8000, 'the second message typed');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(lines(), 2, 'the retry typed nothing');
  assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { cookie, body: { text: 'x', id: 'has space' } })).status, 400);
  assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { cookie, body: { text: 'x', id: 'x'.repeat(41) } })).status, 400);
});
