import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until } from './helpers.ts';

// A message sent while an agent shows a screen in front of its prompt (here a
// sign-in, drawn by a stand-in that acts like a signed-out Codex) waits, and goes
// in once that screen is answered from outside the terminal.
const fixture = fileURLToPath(new URL('./fixtures/signin.js', import.meta.url));
const logged = (log: string, tag: string) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith(`${tag}:`)).map((l) => l.slice(tag.length + 1)) : []);

test('a sign-in screen holds the message, shows its link, code and box, and lets it through once signed in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-it-'));
  const log = `${dir}/keys.log`;
  const ah = await startAh({ auth: { mode: 'off' }, idleAfter: 1, presets: [{ id: 'test-signin', name: 'Test', command: `exec ${process.execPath} ${fixture} ${log}`, match: '^node$', approveKeys: ['y'], denyKeys: ['Escape'] }] }, dir);
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-signin', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { uid } = created.json();
    const window = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    const gated = await until(async () => {
      const w = await window();
      return w?.status === 'waiting' && w.ask?.gate ? w : null;
    }, 15000, 'the sign-in picker shows as waiting');
    assert.equal(gated.ask.gate.kind, 'signin');
    assert.equal(gated.answerable, false, 'no Approve / Deny keys go into a sign-in');
    assert.deepEqual(gated.ask.options.map((o: any) => o.label), ['Sign in with ChatGPT', 'Sign in with Device Code', 'Provide your own API key']);

    const held = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'hello there' } });
    assert.equal(held.status, 200, held.body);
    assert.equal(held.json().outcome, 'queued');
    assert.equal(held.json().held, 'signin');
    const now = await http(ah, 'POST', `/api/sessions/${uid}/queue/${held.json().queueId}/send-now`);
    assert.equal(now.status, 409, 'Send now waits for the sign-in too');
    assert.match(now.json().error, /sign in first/);

    // A row's key picks it, as in the terminal.
    const picked = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: '2' } });
    assert.equal(picked.json().outcome, 'delivered');
    const device = await until(async () => (await window())?.ask?.gate?.code ? await window() : null, 8000, 'the device code screen');
    assert.deepEqual(device.ask.gate, { kind: 'signin', links: ['https://auth.openai.com/codex/device'], code: 'JUC6-GKWC4', back: true });

    // Esc back to the picker, then the API key box: typed in, never remembered.
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/gate`, { body: { back: true } })).status, 200);
    await until(async () => (await window())?.ask?.options?.length === 3, 8000, 'back at the picker');
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/gate`, { body: { text: 'sk-good' } })).status, 409, 'the picker takes nothing typed');
    await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: '3' } });
    await until(async () => (await window())?.ask?.gate?.input, 8000, 'the API key box');
    assert.ok(!logged(log, 'KEY').some((k) => k.includes('hello')), 'nothing of the message was typed into a sign-in screen');
    const typed = await http(ah, 'POST', `/api/sessions/${uid}/gate`, { body: { text: 'sk-good' } });
    assert.equal(typed.status, 200, typed.body);

    // Signed in: the held message goes in, alone and whole.
    await until(() => logged(log, 'PROMPT').length > 0, 15000, 'the held message reached the prompt');
    assert.deepEqual(logged(log, 'PROMPT'), ['hello there']);
    const kept = readFileSync(`${ah.dir}/state/ah/audit.log`, 'utf8') + (existsSync(`${ah.dir}/state/ah/prompts.json`) ? readFileSync(`${ah.dir}/state/ah/prompts.json`, 'utf8') : '');
    assert.doesNotMatch(kept, /sk-good/, 'the key is in no log or history');
  } finally {
    await cleanup(ah);
  }
});

// A sign-in that hands back to 127.0.0.1 (Codex's "Sign in with ChatGPT"): finished from
// another device by pasting the address its browser ended on, which ah opens here.
const callbackFixture = fileURLToPath(new URL('./fixtures/callback.js', import.meta.url));

test("a sign-in whose link scrolled above a short window (a phone's keyboard up) still shows, with its whole link", async () => {
  const fixture = fileURLToPath(new URL('./fixtures/gemini-signin.js', import.meta.url));
  const ah = await startAh({ auth: { mode: 'off' }, idleAfter: 1, presets: [{ id: 'test-gemini', name: 'Test', command: `exec ${process.execPath} ${fixture}`, match: '^node$' }] });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-gemini', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    ah.tmux('resize-window', '-t', id, '-x', '49', '-y', '9');
    const window = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    const w = await until(async () => ((await window())?.ask?.gate ? await window() : null), 15000, 'the sign-in, read from above the screen');
    assert.ok(!ah.tmux('capture-pane', '-p', '-t', id).includes('https://'), 'no link left on the screen itself');
    assert.equal(w.status, 'waiting');
    assert.match(w.ask.gate.links[0], /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?redirect_uri=.*\.apps\.googleusercontent\.com$/);
    assert.equal(w.ask.gate.callback, 'http://127.0.0.1:38637/oauth2callback');
    // Still there a few polls later: it doesn't come and go.
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal((await window())?.ask?.gate?.links?.[0], w.ask.gate.links[0]);
  } finally {
    await cleanup(ah);
  }
});

test("a sign-in that hands back to this host finishes from the address a browser elsewhere ended on", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-it-'));
  const log = `${dir}/keys.log`;
  const ah = await startAh({ auth: { mode: 'off' }, idleAfter: 1, presets: [{ id: 'test-callback', name: 'Test', command: `exec ${process.execPath} ${callbackFixture} ${log}`, match: '^node$' }] }, dir);
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-callback', cwd: `${ah.dir}/files` } });
    const { uid } = created.json();
    const window = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    const w = await until(async () => ((await window())?.ask?.gate?.callback ? await window() : null), 15000, 'the sign-in with its callback');
    const callback: string = w.ask.gate.callback;
    assert.match(callback, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    assert.equal(w.ask.gate.local, true);
    assert.equal(w.ask.gate.back, true, '"Press esc and choose …" goes back');
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'hello after sign-in' } })).json().held, 'signin');

    const gate = (body: object) => http(ah, 'POST', `/api/sessions/${uid}/gate`, { body });
    const port = new URL(callback).port;
    // Only this sign-in's own address is opened: its port, path and state.
    assert.equal((await gate({ callback: `http://127.0.0.1:${port}/auth/callback?code=c0de&state=other` })).status, 400, 'another sign-in');
    assert.equal((await gate({ callback: `http://127.0.0.1:1/auth/callback?code=c0de&state=st4te` })).status, 400, 'another port');
    assert.equal((await gate({ callback: `http://127.0.0.1:${port}/elsewhere?code=c0de&state=st4te` })).status, 400, 'another path');
    assert.equal((await gate({ callback: `http://example.com:${port}/auth/callback?code=c0de&state=st4te` })).status, 400, 'another host');
    assert.ok(!logged(log, 'CALLBACK').length, 'none of those reached the agent');

    const done = await gate({ callback: ` http://localhost:${port}/auth/callback?code=c0de&state=st4te ` });
    assert.equal(done.status, 200, done.body);
    assert.equal(done.json().status, 200, "the agent's own answer");
    assert.deepEqual(logged(log, 'CALLBACK'), ['?code=c0de&state=st4te']);
    await until(() => logged(log, 'PROMPT').length > 0, 15000, 'the held message reached the prompt');
    assert.deepEqual(logged(log, 'PROMPT'), ['hello after sign-in']);
    assert.doesNotMatch(readFileSync(`${ah.dir}/state/ah/audit.log`, 'utf8'), /c0de/, 'the code is in no log');
  } finally {
    await cleanup(ah);
  }
});
