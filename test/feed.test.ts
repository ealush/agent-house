// GUI feed, black box: a live agent's transcript streams as typed events, sends show
// up as appends, and sessions without a transcript or adapter say why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until, type Ah } from './helpers.ts';

const fixture = fileURLToPath(new URL('./fixtures/transcript-agent.js', import.meta.url));

type Msg = { event: string; data: any };

/** Opens an SSE stream and collects its messages until closed. */
function stream(ah: Ah, path: string) {
  const messages: Msg[] = [];
  const req = request({ host: '127.0.0.1', port: ah.port, path, headers: { host: `localhost:${ah.port}` }, agent: false }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = block.match(/^event: (.*)$/m)?.[1];
        const data = block.match(/^data: (.*)$/m)?.[1];
        if (event && data) messages.push({ event, data: JSON.parse(data) });
      }
    });
  });
  req.on('error', () => {});
  req.end();
  return { messages, close: () => req.destroy() };
}

const texts = (entries: any[]) => entries.flatMap((e: any) => e.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text));

test('a live agent streams its transcript as typed events; sends arrive as appends', async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'claude', name: 'Fixture', command: `exec ${process.execPath} ${fixture}`, match: '^node$', feed: 'claude' }],
  });
  const feeds: Array<{ close: () => void }> = [];
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'claude', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { uid } = created.json();
    const w = await until(async () => {
      const w = (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
      return w?.harnessId && w;
    }, 15000, 'transcript adopted');
    assert.equal(w.feed, 'claude');

    const live = stream(ah, `/api/sessions/${uid}/feed/stream`);
    feeds.push(live);
    const snap = await until(() => live.messages.find((m) => m.event === 'snapshot'), 8000, 'snapshot');
    assert.equal(snap.data.reason, 'initial');
    assert.deepEqual(texts(snap.data.entries), ['Start the fixture', 'Ready.']);

    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'ping' } })).status, 200);
    const appended = await until(() => {
      const entries = live.messages.filter((m) => m.event === 'append').flatMap((m) => m.data.entries);
      return entries.length >= 4 && entries;
    }, 8000, 'append');
    const parts = appended.flatMap((e: any) => e.parts);
    const call = parts.find((p: any) => p.type === 'tool_call');
    const result = parts.find((p: any) => p.type === 'tool_result');
    assert.deepEqual(call.call, { id: call.call.id, name: 'Bash', args: { command: 'echo ping', description: 'Echo it' } });
    assert.equal(result.result.callId, call.call.id);
    assert.equal(result.result.text, 'ping');
    assert.deepEqual(parts.find((p: any) => p.type === 'widget').widget, { type: 'choices', prompt: 'Next?', options: [{ label: 'Again', reply: 'again' }, 'Stop'] });
    // Sequences only ever grow.
    const seqs = [...snap.data.entries, ...appended].map((e: any) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));

    const page = (await http(ah, 'GET', `/api/sessions/${uid}/feed?before=${appended[0].seq}`)).json();
    assert.deepEqual(texts(page.entries), ['Start the fixture', 'Ready.']);
    assert.equal(page.hasOlder, false);

    // Discovered history is addressable too, read-only.
    const history = stream(ah, `/api/sessions/claude:${w.harnessId}/feed/stream`);
    feeds.push(history);
    await until(() => history.messages.find((m) => m.event === 'snapshot'), 8000, 'history snapshot');

    const missing = stream(ah, '/api/sessions/claude:does-not-exist/feed/stream');
    feeds.push(missing);
    const why = await until(() => missing.messages.find((m) => m.event === 'unavailable'), 8000, 'unavailable');
    assert.equal(why.data.reason, 'no-transcript');
  } finally {
    for (const f of feeds) f.close();
    await cleanup(ah);
  }
});

test('terminal-only sessions report no adapter', async () => {
  const ah = await startAh({ auth: { mode: 'off' } });
  const feeds: Array<{ close: () => void }> = [];
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: `${ah.dir}/files` } });
    const { uid } = created.json();
    await until(async () => (await http(ah, 'GET', '/api/state')).json().windows.some((w: any) => w.uid === uid), 8000, 'window');
    const s = stream(ah, `/api/sessions/${uid}/feed/stream`);
    feeds.push(s);
    const why = await until(() => s.messages.find((m) => m.event === 'unavailable'), 8000, 'unavailable');
    assert.equal(why.data.reason, 'no-adapter');
    assert.equal((await http(ah, 'GET', `/api/sessions/${uid}/feed`)).status, 404);
  } finally {
    for (const f of feeds) f.close();
    await cleanup(ah);
  }
});
