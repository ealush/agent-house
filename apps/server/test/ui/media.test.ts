// A link to a video on the host plays in the page, streamed: real page → disposable host → a
// Claude-shaped transcript whose reply links a recording in ~/Videos. No production state.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser, type BrowserContextOptions } from 'playwright-core';
import { startAh, cleanup, http, until, type Ah } from '../helpers.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const chrome = [process.env.AH_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome-stable'].find((p) => p && existsSync(p));
const skip = chrome ? false : 'no Chromium';
const shots = process.env.AH_MEDIA_SHOTS;
let ah: Ah;
let browser: Browser;
let scratch: string;
let uid: string;
let home: string;

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(join(tmpdir(), 'ah-media-'));
  const agent = join(scratch, 'agent.mjs');
  // The reply links the recording as agents do: a file:// URL, escaped; a path; and two
  // files the viewer doesn't play (one outside the folders ah serves, one not media).
  writeFileSync(
    agent,
    `import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const home = process.env.HOME;
const id = randomUUID();
const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
let n = 0;
const write = (type, content) => appendFileSync(join(dir, id + '.jsonl'), JSON.stringify({ type, uuid: type + '-' + ++n, sessionId: id, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: type, content } }) + '\\n');
write('user', [{ type: 'text', text: 'Give me a link to the recording' }]);
write('assistant', [{ type: 'text', text: [
  'I copied it into ~/Videos.',
  '',
  '- The cut: [file://' + home + '/Videos/agent%20house.mp4](file://' + home + '/Videos/agent%20house.mp4)',
  '- Same, by path: [~/Videos/agent house.mp4](<~/Videos/agent house.mp4>)',
  '- An old one: [loose.mp4](file://' + home + '/loose.mp4)',
  '- Notes: [notes.txt](file://' + process.cwd() + '/notes.txt)',
].join('\\n') }]);
console.log('READY');
setInterval(() => {}, 1 << 30);
`,
  );
  const dist = join(scratch, 'dist');
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });
  const saved = process.env.AH_DIST;
  process.env.AH_DIST = dist;
  try {
    ah = await startAh({ auth: { mode: 'off' }, idleAfter: 1, presets: [{ id: 'claude', name: 'Media test', command: `exec ${process.execPath} ${agent}`, match: '^node$', feed: 'claude' }] });
  } finally {
    if (saved === undefined) delete process.env.AH_DIST;
    else process.env.AH_DIST = saved;
  }
  home = join(ah.dir, 'home');
  mkdirSync(join(home, 'Videos'), { recursive: true });
  copyFileSync(join(root, 'test/fixtures/clip.mp4'), join(home, 'Videos', 'agent house.mp4'));
  copyFileSync(join(root, 'test/fixtures/clip.mp4'), join(home, 'loose.mp4'));
  writeFileSync(join(ah.dir, 'files', 'notes.txt'), 'notes');
  const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'claude', cwd: `${ah.dir}/files`, label: 'Media test' } });
  assert.equal(created.status, 201, created.body);
  uid = created.json().uid;
  await until(async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid && w.harnessId), 20_000, 'the transcript');
  browser = await chromium.launch({ executablePath: chrome });
  if (shots) mkdirSync(shots, { recursive: true });
});

after(async () => {
  await browser?.close();
  if (ah) await cleanup(ah);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function open(options: BrowserContextOptions) {
  for (const previous of browser.contexts()) await previous.close();
  const ctx = await browser.newContext({ ...options, ...(shots ? { recordVideo: { dir: shots, size: options.viewport ?? undefined } } : {}) });
  const errors: string[] = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const ranges: number[] = [];
  page.on('response', (res) => {
    if (res.url().includes('/api/fs/media')) ranges.push(res.status());
  });
  await page.addInitScript(() => {
    localStorage.setItem('ah.view', 'gui');
    localStorage.setItem('ah.theme', 'light');
  });
  // The GUI's code in late, as on a loaded runner: it arrives with a video already open,
  // which must keep playing where it is rather than be closed by the session remounting.
  await page.route(/GuiSurface[^/]*\.js$/, async (route) => { await new Promise((r) => setTimeout(r, 3000)); await route.continue(); });
  await page.goto(`http://localhost:${ah.port}/#${uid}`, { waitUntil: 'domcontentloaded' });
  const reply = page.locator('.msg').filter({ hasText: 'I copied it into ~/Videos.' });
  await reply.waitFor({ timeout: 20_000 });
  return { ctx, page, reply, errors, ranges };
}

/** The viewer's video once it plays: muted, so no gesture policy stands in the way. */
const playing = (page: import('playwright-core').Page) =>
  page.locator('dialog.file-preview video').evaluate(async (v: HTMLVideoElement) => {
    v.muted = true;
    await v.play();
    await new Promise<void>((done) => (v.currentTime > 0.3 ? done() : v.addEventListener('timeupdate', function on() {
      if (v.currentTime > 0.3) {
        v.removeEventListener('timeupdate', on);
        done();
      }
    })));
    return { duration: v.duration, width: v.videoWidth };
  });

test('desktop: a file:// link to a video in ~/Videos plays in the page, streamed in ranges, and seeks', { skip, timeout: 90_000 }, async () => {
  const { ctx, page, reply, errors, ranges } = await open({ viewport: { width: 1280, height: 800 } });
  const links = reply.locator('a');
  const href = await links.nth(0).getAttribute('href');
  assert.match(href ?? '', /\/api\/fs\/media\?path=/, 'a media link names its stream (⌘-click opens it in a tab)');
  assert.equal(decodeURIComponent(href!.split('path=')[1]), join(home, 'Videos', 'agent house.mp4'), 'the file:// URL, unescaped');
  if (shots) await reply.screenshot({ path: join(shots, 'desktop-reply.png') });

  await links.nth(0).click();
  const viewer = page.locator('dialog.file-preview');
  await viewer.locator('video').waitFor();
  const shown = await playing(page);
  assert.ok(Math.abs(shown.duration - 3) < 0.2, `the whole clip: ${shown.duration}s`);
  assert.equal(shown.width, 240);
  const seeked = await viewer.locator('video').evaluate(
    (v: HTMLVideoElement) =>
      new Promise<number>((done) => {
        v.addEventListener('seeked', () => done(v.currentTime), { once: true });
        v.currentTime = 2.5;
      }),
  );
  assert.ok(seeked >= 2.4, `seeked to ${seeked}`);
  assert.ok(ranges.includes(206), `streamed in byte ranges: ${ranges.join(', ')}`);
  assert.equal(await viewer.getByRole('link', { name: 'Download' }).getAttribute('download'), 'agent house.mp4');
  if (shots) await page.screenshot({ path: join(shots, 'desktop-playing.png') });
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });

  // A path link plays the same file.
  await links.nth(1).click();
  await viewer.locator('video').waitFor();
  await playing(page);
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });

  // Outside the folders the host serves: its reason, not a player that won't start.
  await links.nth(2).click();
  await viewer.getByText(/Couldn’t open it: outside the folders ah serves/).waitFor();
  assert.equal(await viewer.locator('video').count(), 0);
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });

  // A file:// link to anything else opens through the files API, as a path link does.
  assert.equal(await links.nth(3).getAttribute('href'), `/api/fs/file?path=${encodeURIComponent(join(ah.dir, 'files', 'notes.txt'))}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: the video plays in the sheet', { skip, timeout: 90_000 }, async () => {
  const { ctx, page, reply, errors } = await open(devices['iPhone 15 Pro']);
  await reply.locator('a').first().tap();
  await page.locator('dialog.file-preview video').waitFor();
  await playing(page);
  if (shots) await page.screenshot({ path: join(shots, 'phone-playing.png') });
  assert.deepEqual(errors, []);
  await ctx.close();
});
