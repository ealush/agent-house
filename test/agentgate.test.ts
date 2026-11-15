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
