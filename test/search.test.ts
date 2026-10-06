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
