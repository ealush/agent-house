// A Markdown document an agent links reads as it's meant to, in the page: real page →
// disposable host → a Claude-shaped transcript whose reply links a review the way Gemini
// writes them (in its own artifact folder, with pictures beside it) and shows a picture on
// the host itself. No production state.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser, type BrowserContextOptions } from 'playwright-core';
import { startAh, cleanup, http, until, type Ah } from '../helpers.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const chrome = [process.env.AH_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome-stable'].find((p) => p && existsSync(p));
const skip = chrome ? false : 'no Chromium';
const shots = process.env.AH_MARKDOWN_SHOTS;
// A 48×24 orange picture.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADAAAAAYCAIAAAAzn+mLAAAALElEQVR42u3OAQkAAAgDsMcxk/0xhzUEBwuwTNcpERISEhISEhISEhIS+hVa2hBUW4vlBT8AAAAASUVORK5CYII=', 'base64');
let ah: Ah;
let browser: Browser;
let scratch: string;
let uid: string;
let brain: string;

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(join(tmpdir(), 'ah-mdfile-'));
  const agent = join(scratch, 'agent.mjs');
  writeFileSync(
    agent,
    `import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const brain = process.env.HOME + '/.gemini/antigravity-cli/brain/c0ffee';
const id = randomUUID();
const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
let n = 0;
const write = (type, content) => appendFileSync(join(dir, id + '.jsonl'), JSON.stringify({ type, uuid: type + '-' + ++n, sessionId: id, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: type, content } }) + '\\n');
write('user', [{ type: 'text', text: 'Write up the review' }]);
write('assistant', [{ type: 'text', text: [
  'The review is ready in [review.md](file://' + brain + '/review.md).',
  '',
  '![The swipe](shot.png)',
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
    ah = await startAh({ auth: { mode: 'off' }, idleAfter: 1, presets: [{ id: 'claude', name: 'Review test', command: `exec ${process.execPath} ${agent}`, match: '^node$', feed: 'claude' }] });
  } finally {
    if (saved === undefined) delete process.env.AH_DIST;
    else process.env.AH_DIST = saved;
  }
  brain = join(ah.dir, 'home', '.gemini', 'antigravity-cli', 'brain', 'c0ffee');
  mkdirSync(join(brain, 'evidence'), { recursive: true });
  writeFileSync(join(brain, 'evidence', 'swipe.png'), PNG);
  writeFileSync(
    join(brain, 'review.md'),
    [
      '# Polish review',
      '',
      'Fourteen items, **twelve** ready to land.',
      '',
      '| # | Item | Verdict |',
      '|---|---|---|',
      '| 9 | Swipe badge | Land |',
      '',
      '![Swipe badge](evidence/swipe.png)',
      '',
      'See [the notes](./notes.md) and [the spec](https://example.com/spec).',
    ].join('\n'),
  );
  writeFileSync(join(brain, 'notes.md'), '# Notes\n\nRecorded on the simulator.');
  writeFileSync(join(ah.dir, 'files', 'shot.png'), PNG);
  const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'claude', cwd: `${ah.dir}/files`, label: 'Review test' } });
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

async function open(options: BrowserContextOptions, theme = 'light') {
  for (const previous of browser.contexts()) await previous.close();
  const ctx = await browser.newContext(options);
  const errors: string[] = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((t) => {
    localStorage.setItem('ah.view', 'gui');
    localStorage.setItem('ah.theme', t);
  }, theme);
  await page.goto(`http://localhost:${ah.port}/#${uid}`, { waitUntil: 'domcontentloaded' });
  const reply = page.locator('.msg').filter({ hasText: 'The review is ready' });
  await reply.waitFor({ timeout: 20_000 });
  return { ctx, page, reply, errors };
}

/** A picture once it has loaded: its natural width, 0 when it couldn't be. */
const loaded = (img: import('playwright-core').Locator) =>
  img.evaluate((el: HTMLImageElement) => (el.complete && el.naturalWidth ? el.naturalWidth : new Promise<number>((done) => {
    el.addEventListener('load', () => done(el.naturalWidth), { once: true });
    el.addEventListener('error', () => done(0), { once: true });
  })));

test('desktop: a linked review opens rendered, its picture drawn, its links followed and Back', { skip, timeout: 90_000 }, async () => {
  const { ctx, page, reply, errors } = await open({ viewport: { width: 1280, height: 860 } });
  // The picture in the message itself, from the session's folder.
  assert.equal(await loaded(reply.locator('img.md-picture')), 48, 'a picture on the host draws in the message');
  if (shots) await reply.screenshot({ path: join(shots, 'desktop-reply.png') });

  await reply.getByRole('link', { name: 'review.md' }).click();
  const viewer = page.locator('dialog.file-preview');
  await viewer.getByRole('heading', { name: 'Polish review' }).waitFor();
  assert.equal(await viewer.locator('table td').first().textContent(), '9', 'a table is a table');
  assert.equal(await loaded(viewer.locator('img.md-picture')), 48, 'its picture, beside it in evidence/, drawn');
  assert.equal(await viewer.getByRole('link', { name: 'the spec' }).getAttribute('target'), '_blank', 'a web link leaves for a tab');
  if (shots) await page.waitForTimeout(600).then(() => page.screenshot({ path: join(shots, 'desktop-review.png') }));

  await viewer.getByRole('button', { name: 'Source' }).click();
  assert.match((await viewer.locator('pre').textContent()) ?? '', /^# Polish review/);
  await viewer.getByRole('button', { name: 'Rendered' }).click();

  await viewer.getByRole('link', { name: 'the notes' }).click();
  await viewer.getByRole('heading', { name: 'Notes' }).waitFor();
  assert.match((await viewer.locator('.file-preview-path').textContent()) ?? '', /c0ffee\/notes\.md$/);
  await viewer.getByRole('button', { name: 'Back' }).click();
  await viewer.getByRole('heading', { name: 'Polish review' }).waitFor();
  assert.equal(await viewer.getByRole('button', { name: 'Back' }).count(), 0, 'nothing further back');
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: the review reads in the sheet, in the dark too', { skip, timeout: 90_000 }, async () => {
  const { ctx, page, reply, errors } = await open(devices['iPhone 15 Pro'], 'dark');
  await reply.getByRole('link', { name: 'review.md' }).tap();
  const viewer = page.locator('dialog.file-preview');
  await viewer.getByRole('heading', { name: 'Polish review' }).waitFor();
  assert.equal(await loaded(viewer.locator('img.md-picture')), 48);
  if (shots) await page.waitForTimeout(600).then(() => page.screenshot({ path: join(shots, 'phone-review-dark.png') }));
  assert.deepEqual(errors, []);
  await ctx.close();
});
