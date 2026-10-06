import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, http, signIn, startAh, until } from './helpers.ts';

// Black-box: the search routes over HTTP against a real server whose Claude
// config dir holds one conversation about a singing kettle (issue #9).
test('search routes: status, transcript hit at its seq, aggregate, disable drops the index', async () => {
  const ah = await startAh();
  try {
    const cookie = await signIn(ah);
    const files = join(ah.dir, 'files');
    const projDir = join(ah.dir, 'claude', 'projects', '-home-u-code-kettle');
    await mkdir(projDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'user', isSidechain: false, cwd: files, timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'find the singing kettle bug' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T10:01:00.000Z', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'the singing kettle bug is a loose valve' }] } }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Singing kettle bug', sessionId: 'kettle1' }),
    ];
    await writeFile(join(projDir, 'kettle1.jsonl'), lines.join('\n') + '\n');

    // The indexer builds in the background after boot; poll its status.
    const ready = await until(async () => {
      const r = await http(ah, 'GET', '/api/search/status', { cookie });
      return r.status === 200 && r.json().transcriptEntries >= 2 ? r.json() : null;
    }, 30_000, 'index to cover the kettle transcript');
    assert.equal(ready.enabled, true);

    const hit = await http(ah, 'GET', '/api/search?q=singing%20kettle', { cookie });
    assert.equal(hit.status, 200);
    const body = hit.json();
    assert.equal(body.total, 1);
    assert.equal(body.results[0].title, 'Singing kettle bug');
    assert.equal(body.results[0].kind, 'transcript');
    assert.equal(body.results[0].excerpts[0].seq, 1);

    const all = await http(ah, 'GET', '/api/search/all?q=singing%20kettle', { cookie });
    assert.equal(all.status, 200);
    assert.equal(all.json().total, 1);
    assert.deepEqual(all.json().notes, []);

    // Unauthenticated callers get nothing.
    assert.equal((await http(ah, 'GET', '/api/search?q=kettle')).status, 401);

    // Disable: the status flips and search reports itself off.
    const off = await http(ah, 'POST', '/api/search/enabled', { cookie, body: { enabled: false } });
    assert.equal(off.status, 200);
    assert.equal(off.json().enabled, false);
    const after = await http(ah, 'GET', '/api/search?q=kettle', { cookie });
    assert.equal(after.json().enabled, false);
    assert.deepEqual(after.json().results, []);
  } finally {
    await cleanup(ah);
  }
});


test('aggregate search pages the global host order and preserves total and date filters', async () => {
  const peer = await startAh();
  const hub = await startAh({ peers: [{ name: 'other', url: `http://127.0.0.1:${peer.port}`, token: peer.localToken() }] });
  try {
    for (const [hostIndex, ah] of [hub, peer].entries()) {
      const project = join(ah.dir, 'claude', 'projects', 'search-pages');
      await mkdir(project, { recursive: true });
      for (let i = 0; i < 4; i++) {
        const day = 1 + i * 2 + hostIndex;
        await writeFile(join(project, `s${day}.jsonl`), JSON.stringify({ type: 'user', cwd: join(ah.dir, 'files'), timestamp: `2026-10-0${day}T10:00:00Z`, message: { content: 'pagination walrus' } }) + '\n');
      }
      await http(ah, 'POST', '/api/search/rebuild', { token: ah.localToken(), body: {} });
      await until(async () => (await http(ah, 'GET', '/api/search?q=walrus', { token: ah.localToken() })).json().total === 4, 30000, 'four indexed sources');
    }
    await until(async () => (await http(hub, 'GET', '/api/state', { token: hub.localToken() })).json().hosts.some((h: any) => h.name === 'other' && h.online), 10000, 'peer online');
    const get = async (suffix: string) => (await http(hub, 'GET', `/api/search/all?q=walrus${suffix}`, { token: hub.localToken() })).json();
    const first = await get('&limit=3');
    const second = await get('&limit=3&offset=3');
    const third = await get('&limit=3&offset=6');
    assert.equal(first.total, 8); assert.equal(second.total, 8); assert.equal(third.total, 8);
    const hits = [...first.results, ...second.results, ...third.results];
    assert.deepEqual(hits.map((h: any) => new Date(h.at).getUTCDate()), [8, 7, 6, 5, 4, 3, 2, 1]);
    assert.equal(new Set(hits.map((h: any) => `${h.host}:${h.ref}`)).size, 8);
    assert.equal((await get('&h=other')).total, 4);
    assert.equal((await get(`&from=${Date.parse('2026-10-05')}`)).total, 4);
  } finally { await cleanup(hub); await cleanup(peer); }
});
