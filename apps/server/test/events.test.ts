// The state stream: the whole state first, then patches; a delta stream (?delta=1) gets
// the windows that changed instead of all of them, and a plain one (an older page) all.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startAh, cleanup, http, signIn, until, type Ah } from './helpers.ts';

let ah: Ah;
let cookie: string;
before(async () => {
  ah = await startAh();
  cookie = await signIn(ah);
});
after(() => cleanup(ah));

function stream(path: string) {
  const events: Array<{ type: string; data: any }> = [];
  let buf = '';
  const req = request({ host: '127.0.0.1', port: ah.port, path, headers: { host: `localhost:${ah.port}`, cookie } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (type && data) events.push({ type, data: JSON.parse(data) });
      }
    });
  });
  req.end();
  return { events, close: () => req.destroy() };
}

test('a delta stream gets the windows that changed; a plain one, all of them', async () => {
  const delta = stream('/api/events?delta=1');
  const plain = stream('/api/events');
  await until(() => delta.events.length && plain.events.length, 8000, 'first state');
  assert.equal(delta.events[0].type, 'state');
  const a = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files`, label: 'delta-a' } });
  assert.equal(a.status, 201, a.body);
  const uid = a.json().uid;
  const withA = (e: { type: string; data: any }) => e.type === 'patch' && (e.data.windowsDelta?.changed ?? e.data.windows ?? []).some((w: any) => w.uid === uid);
  const d = await until(() => delta.events.find(withA), 8000, 'a delta with the new window');
  assert.equal(d.data.windows, undefined, 'no whole list');
  assert.ok(d.data.windowsDelta.order.includes(uid));
  const p = await until(() => plain.events.find(withA), 8000, 'a plain patch with it');
  assert.ok(Array.isArray(p.data.windows), 'the whole list, as before');
  assert.equal(p.data.windowsDelta, undefined);
  delta.close();
  plain.close();
});
