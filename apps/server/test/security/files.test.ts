// The file browser is easier to misuse than a terminal: keep it to configured roots,
// and keep what it writes private.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

test("a folder's @ completion lists files inside the roots only, relative to the folder", async () => {
  const project = join(ah.dir, 'files', 'notes-project');
  mkdirSync(join(project, 'docs'), { recursive: true });
  writeFileSync(join(project, 'docs', 'SPEC.md'), '# spec');
  writeFileSync(join(project, 'README.md'), 'hi');
  symlinkSync(homedir(), join(project, 'home-link'));
  const ask = (dir: string, q = '') => http(ah, 'GET', `/api/fs/complete?dir=${encodeURIComponent(dir)}&q=${encodeURIComponent(q)}`, { cookie });
  const all = await ask(project);
  assert.equal(all.status, 200, all.body);
  assert.deepEqual([...all.json()].sort(), ['README.md', 'docs/SPEC.md', 'home-link'], 'a symlink out is named, never walked');
  assert.deepEqual((await ask(project, 'spec')).json(), ['docs/SPEC.md']);
  assert.equal((await ask(join(project, 'README.md'))).status, 400, 'a file is not a folder');
  for (const dir of [homedir(), '/etc', join(project, 'home-link'), `${project}/../../config`, '', 'relative/dir']) {
    const res = await ask(dir);
    assert.ok([400, 403, 404].includes(res.status), `${dir} → ${res.status}`);
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

test('media streams in byte ranges from the roots and the media folders, pictures, video and sound only', async () => {
  const root = join(ah.dir, 'files');
  const videos = join(ah.dir, 'home', 'Videos');
  mkdirSync(videos, { recursive: true });
  mkdirSync(join(ah.dir, 'home', '.ssh'), { recursive: true });
  writeFileSync(join(videos, 'clip.mp4'), '0123456789');
  writeFileSync(join(videos, 'notes.txt'), 'not media');
  writeFileSync(join(ah.dir, 'home', 'loose.mp4'), 'home is no media folder');
  writeFileSync(join(ah.dir, 'home', '.ssh', 'id_ed25519'), 'key');
  writeFileSync(join(root, 'song.mp3'), 'ID3');
  symlinkSync(join(ah.dir, 'home', '.ssh', 'id_ed25519'), join(videos, 'key.mp4'));
  symlinkSync(join(videos, 'notes.txt'), join(videos, 'renamed.mp4'));
  const media = (path: string, headers: Record<string, string> = {}) => http(ah, 'GET', `/api/fs/media?path=${encodeURIComponent(path)}`, { cookie, headers });

  const whole = await media(join(videos, 'clip.mp4'));
  assert.equal(whole.status, 200, whole.body);
  assert.equal(whole.body, '0123456789');
  assert.equal(whole.headers['content-type'], 'video/mp4');
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.match(String(whole.headers['content-disposition']), /^inline/);
  assert.match(String(whole.headers['content-security-policy']), /sandbox/);
  assert.equal(whole.headers['x-content-type-options'], 'nosniff');

  const part = await media('~/Videos/clip.mp4', { range: 'bytes=2-5' });
  assert.equal(part.status, 206);
  assert.equal(part.body, '2345');
  assert.equal(part.headers['content-range'], 'bytes 2-5/10');
  assert.equal(part.headers['content-length'], '4');
  assert.equal((await media(join(videos, 'clip.mp4'), { range: 'bytes=-3' })).body, '789');
  const past = await media(join(videos, 'clip.mp4'), { range: 'bytes=10-' });
  assert.equal(past.status, 416);
  assert.equal(past.headers['content-range'], 'bytes */10');

  assert.equal((await media(join(root, 'song.mp3'))).headers['content-type'], 'audio/mpeg', 'the roots stream media too');
  for (const [path, status] of [
    [join(videos, 'notes.txt'), 415],
    [join(videos, 'renamed.mp4'), 415],
    [join(videos, 'key.mp4'), 403],
    [join(ah.dir, 'home', 'loose.mp4'), 403],
    [join(ah.dir, 'home', '.ssh', 'id_ed25519'), 403],
    ['/etc/passwd', 403],
    [join(videos, 'missing.mp4'), 404],
    ['Videos/clip.mp4', 400],
  ] as const) {
    assert.equal((await media(path)).status, status, path);
  }
  assert.equal((await http(ah, 'GET', `/api/fs/file?path=${encodeURIComponent(join(videos, 'clip.mp4'))}`, { cookie })).status, 403, 'the media folders are not browsable');
});

test('a media folder made after the host started, even as a link elsewhere, streams', async () => {
  // ~/Music didn't exist when the host started; now it's a link to where the music really is.
  const real = join(ah.dir, 'elsewhere-music');
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, 'take.m4a'), 'm4a');
  symlinkSync(real, join(ah.dir, 'home', 'Music'));
  const res = await http(ah, 'GET', `/api/fs/media?path=${encodeURIComponent('~/Music/take.m4a')}`, { cookie });
  assert.equal(res.status, 200, res.body);
  assert.equal(res.headers['content-type'], 'audio/mp4');
});

test('prompt history can be cleared', async () => {
  assert.equal((await http(ah, 'DELETE', '/api/prompts', { cookie })).status, 200);
  assert.deepEqual((await http(ah, 'GET', '/api/prompts', { cookie })).json(), []);
});
