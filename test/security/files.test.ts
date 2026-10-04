// The file browser is easier to misuse than a terminal: keep it to configured roots,
// and keep what it writes private.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startAh, cleanup, http, signIn, type Ah } from '../helpers.ts';

let ah: Ah;
let cookie: string;
before(async () => {
  ah = await startAh();
  cookie = await signIn(ah);
});
after(() => cleanup(ah));

test('only configured roots are browsable — not $HOME, its dotfiles, or symlinks out', async () => {
  const root = join(ah.dir, 'files');
  writeFileSync(join(root, 'ok.txt'), 'fine');
  symlinkSync(homedir(), join(root, 'home-link'));
  assert.equal((await http(ah, 'GET', `/api/fs/list?path=${encodeURIComponent(root)}`, { cookie })).status, 200);
  assert.equal((await http(ah, 'GET', `/api/fs/file?path=${encodeURIComponent(join(root, 'ok.txt'))}`, { cookie })).body, 'fine');
  for (const path of [homedir(), join(homedir(), '.ssh'), '/etc', join(root, 'home-link'), join(root, '..'), `${root}/../config/ah/config.json`]) {
    const res = await http(ah, 'GET', `/api/fs/list?path=${encodeURIComponent(path)}`, { cookie });
    assert.ok(res.status === 403 || res.status === 404, `${path} → ${res.status}`);
  }
});

test('uploads are owner-only (0600), both paste uploads and folder uploads', async () => {
  const root = join(ah.dir, 'files');
  const a = await http(ah, 'POST', `/api/fs/upload?dir=${encodeURIComponent(root)}&name=secret.txt`, { cookie, raw: 'shh' });
  const b = await http(ah, 'POST', '/api/upload?name=shot.png', { cookie, raw: 'png' });
  for (const res of [a, b]) {
    assert.equal(res.status, 201, res.body);
    assert.equal(statSync(res.json().path).mode & 0o777, 0o600);
  }
});

test('downloads are sandboxed and never rendered as HTML', async () => {
  const root = join(ah.dir, 'files');
  writeFileSync(join(root, 'x.html'), '<script>alert(1)</script>');
  const res = await http(ah, 'GET', `/api/fs/file?path=${encodeURIComponent(join(root, 'x.html'))}`, { cookie });
  assert.match(String(res.headers['content-type']), /^text\/plain/);
  assert.match(String(res.headers['content-security-policy']), /sandbox/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('prompt history can be cleared', async () => {
  assert.equal((await http(ah, 'DELETE', '/api/prompts', { cookie })).status, 200);
  assert.deepEqual((await http(ah, 'GET', '/api/prompts', { cookie })).json(), []);
});
