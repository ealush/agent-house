// A message's pictures open over the page and page through: real page → disposable host →
// a Claude-shaped transcript carrying pictures. No production state.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { chromium, devices, type Browser, type BrowserContextOptions, type Page } from 'playwright-core';
import { startAh, cleanup, http, until, type Ah } from '../helpers.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const chrome = [process.env.AH_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome-stable'].find((p) => p && existsSync(p));
const skip = chrome ? false : 'no Chromium';
const shots = process.env.AH_GALLERY_SHOTS;
let ah: Ah;
let browser: Browser;
let scratch: string;
let uid: string;

/** A w×h PNG: a diagonal wash between two colours, a disc in the middle, so each one is told apart at a glance. */
function png(w: number, h: number, from: number[], to: number[]): string {
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      const disc = Math.hypot(x - w / 2, y - h / 2) < Math.min(w, h) / 5;
      for (let c = 0; c < 3; c++) raw[y * row + 1 + x * 3 + c] = disc ? 255 : Math.round(from[c] + (to[c] - from[c]) * t);
    }
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(join(tmpdir(), 'ah-gallery-'));
  const pictures = [
    png(480, 320, [255, 94, 58], [255, 190, 11]),
    png(300, 420, [58, 134, 255], [131, 56, 236]),
    png(520, 260, [6, 214, 160], [17, 138, 178]),
    png(360, 360, [239, 71, 111], [255, 209, 102]),
    png(400, 240, [42, 157, 143], [233, 196, 106]),
  ];
  // A Claude Code-shaped transcript: your message with three pictures, then a tool that saw two.
  const agent = join(scratch, 'agent.mjs');
  writeFileSync(
    agent,
    `import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const pictures = ${JSON.stringify(pictures)};
const image = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const id = randomUUID();
const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
let n = 0;
const write = (type, content, extra = {}) => appendFileSync(join(dir, id + '.jsonl'), JSON.stringify({ type, uuid: type + '-' + ++n, sessionId: id, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: type, content }, ...extra }) + '\\n');
write('user', [{ type: 'text', text: '[Image #4] [Image #5] [Image #6] Which of these reads best?' }, ...pictures.slice(0, 3).map(image)]);
write('assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Screenshot', input: { what: 'both pages' } }]);
write('user', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'Two pages' }, ...pictures.slice(3).map(image)], is_error: false }]);
write('assistant', [{ type: 'text', text: 'The second one.' }]);
console.log('READY');
setInterval(() => {}, 1 << 30);
`,
  );
  const dist = join(scratch, 'dist');
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });
  const saved = process.env.AH_DIST;
  process.env.AH_DIST = dist;
  try {
    ah = await startAh({ auth: { mode: 'off' }, idleAfter: 1, presets: [{ id: 'claude', name: 'Gallery test', command: `exec ${process.execPath} ${agent}`, match: '^node$', feed: 'claude' }] });
  } finally {
    if (saved === undefined) delete process.env.AH_DIST;
    else process.env.AH_DIST = saved;
  }
  const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'claude', cwd: `${ah.dir}/files`, label: 'Gallery test' } });
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

async function open(options: BrowserContextOptions, init: Record<string, string> = {}) {
  for (const previous of browser.contexts()) await previous.close();
  // With AH_GALLERY_SHOTS, a recording of each test for the PR.
  const ctx = await browser.newContext({ ...options, ...(shots ? { recordVideo: { dir: shots, size: options.viewport ?? undefined } } : {}) });
  const errors: string[] = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((init) => {
    localStorage.setItem('ah.view', 'gui');
    localStorage.setItem('ah.theme', 'light');
    for (const [k, v] of Object.entries(init)) localStorage.setItem(k, v);
  }, init);
  // The GUI's code in late, as on a slow machine: the page shows its lazy stand-in first and
  // must keep it once the code is in, or a gallery opened in it closes on the next render.
  await page.route(/GuiSurface[^/]*\.js$/, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  await page.goto(`http://localhost:${ah.port}/#${uid}`, { waitUntil: 'domcontentloaded' });
  const message = page.locator('.msg.user').filter({ hasText: 'Which of these reads best?' });
  await message.waitFor({ timeout: 20_000 });
  return { ctx, page, message, errors };
}

const gallery = (page: Page) => page.locator('dialog.gallery');
const label = (page: Page) => gallery(page).getAttribute('aria-label');
/** The picture the gallery has in view, by its place in the track. */
const shown = (page: Page) =>
  gallery(page).evaluate((d) => {
    const stage = d.querySelector('.gallery-stage')!.getBoundingClientRect();
    return [...d.querySelectorAll('.gallery-slide')].findIndex((s) => Math.abs(s.getBoundingClientRect().left - stage.left) < 2);
  });
const settled = (page: Page) => page.waitForFunction(() => !document.querySelector('dialog.gallery')?.getAnimations({ subtree: true }).some((a) => a.playState === 'running'));

test('desktop: in a grid, a message’s pictures open where you clicked, and the arrows page through them', { skip, timeout: 60_000 }, async () => {
  const { ctx, page, message, errors } = await open({ viewport: { width: 1280, height: 800 } }, { 'ah.pictures': 'grid' });
  const tiles = message.locator('.pic');
  assert.equal(await tiles.count(), 3, 'the three pictures, as one group');
  if (shots) await message.screenshot({ path: join(shots, 'desktop-grid.png') });
  await tiles.nth(1).click();
  await gallery(page).waitFor();
  assert.equal(await label(page), 'Picture 2, 2 of 3');
  await settled(page);
  assert.equal(await shown(page), 1, 'the one clicked');
  if (shots) await page.screenshot({ path: join(shots, 'desktop-open.png') });
  await page.keyboard.press('ArrowRight');
  assert.equal(await label(page), 'Picture 3, 3 of 3');
  await page.keyboard.press('ArrowRight');
  assert.equal(await label(page), 'Picture 3, 3 of 3', 'the last stays the last');
  await page.getByRole('button', { name: 'Previous picture' }).click();
  await page.getByRole('button', { name: 'Previous picture' }).click();
  assert.equal(await label(page), 'Picture 1, 1 of 3');
  await settled(page);
  assert.equal(await shown(page), 0);
  await page.getByRole('tab', { name: 'Picture 3, 3 of 3' }).click();
  assert.equal(await label(page), 'Picture 3, 3 of 3', 'a dot goes straight to its picture');
  await page.keyboard.press('Escape');
  await gallery(page).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Picture 3, 3 of 3', 'focus back on the tile it was showing');
  // A tool's pictures are a group of their own.
  await page.locator('.tool-head').filter({ hasText: 'Screenshot' }).click();
  const toolTiles = page.locator('.tool-images .pic');
  await toolTiles.first().waitFor();
  assert.equal(await toolTiles.count(), 2);
  await toolTiles.first().click();
  assert.equal(await label(page), 'Picture 1, 1 of 2');
  await page.keyboard.press('Escape');
  await gallery(page).waitFor({ state: 'detached' });
  // The agent took the pictures out of the words ("[Image #5]"): each is a chip where it was,
  // which opens it.
  const chips = message.locator('.mention-chip');
  assert.deepEqual(await chips.allTextContents(), ['@Picture-1', '@Picture-2', '@Picture-3']);
  assert.equal((await message.textContent())?.includes('[Image #'), false);
  await chips.nth(1).click();
  await gallery(page).waitFor();
  assert.equal(await label(page), 'Picture 2, 2 of 3');
  await page.keyboard.press('Escape');
  await gallery(page).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await ctx.close();
});

/** A finger across the screen through CDP, as iOS sends it. */
async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('phone: a swipe goes to the next picture, the first and last give, and a flick down puts it away', { skip, timeout: 60_000 }, async () => {
  const { ctx, page, message, errors } = await open(devices['iPhone 15 Pro']);
  const { width, height } = page.viewportSize()!;
  if (shots) await message.screenshot({ path: join(shots, 'phone-stack.png') });
  await message.locator('.pic-pile').tap();
  await gallery(page).waitFor();
  await settled(page);
  assert.equal(await label(page), 'Picture 1, 1 of 3');
  if (shots) await page.screenshot({ path: join(shots, 'phone-open.png') });
  await swipe(page, { x: width * 0.8, y: height / 2 }, { x: width * 0.2, y: height / 2 });
  assert.equal(await label(page), 'Picture 2, 2 of 3', 'swiped left: the next');
  await settled(page);
  assert.equal(await shown(page), 1);
  await swipe(page, { x: width * 0.3, y: height / 2 }, { x: width * 0.5, y: height / 2 });
  assert.equal(await label(page), 'Picture 1, 1 of 3', 'swiped right: the one before');
  // Past the first there's nothing: it gives under the finger, then settles back on the first.
  await swipe(page, { x: width * 0.2, y: height / 2 }, { x: width * 0.9, y: height / 2 });
  await settled(page);
  assert.equal(await label(page), 'Picture 1, 1 of 3');
  assert.equal(await shown(page), 0);
  // A short drag sideways comes back.
  await swipe(page, { x: width * 0.6, y: height / 2 }, { x: width * 0.55, y: height / 2 }, 4);
  await settled(page);
  assert.equal(await shown(page), 0);
  // A tap on the picture puts the bar away; another brings it back.
  await page.touchscreen.tap(width / 2, height / 2);
  await until(async () => (await gallery(page).getAttribute('class'))!.includes('bare'), 2000, 'the bar put away');
  await page.touchscreen.tap(width / 2, height / 2);
  await until(async () => !(await gallery(page).getAttribute('class'))!.includes('bare'), 2000, 'the bar back');
  await swipe(page, { x: width / 2, y: height * 0.4 }, { x: width / 2, y: height * 0.75 });
  await gallery(page).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('desktop: several pictures sit in a pile by default, and Settings → Appearance lays them out as a grid', { skip, timeout: 60_000 }, async () => {
  const { ctx, page, message, errors } = await open({ viewport: { width: 1280, height: 800 } });
  const pile = message.locator('.pic-pile');
  assert.equal(await pile.count(), 1, 'one pile for the three');
  assert.equal(await message.locator('.pic').count(), 0);
  assert.equal(await pile.getAttribute('aria-label'), '3 pictures: Picture 1, Picture 2, Picture 3');
  assert.equal((await pile.locator('.pile-count').innerText()).trim(), '3');
  assert.equal(await pile.locator('.pile-card').count(), 3, 'the top one and two under it');
  if (shots) await message.screenshot({ path: join(shots, 'desktop-stack.png') });
  await pile.hover();
  await page.waitForTimeout(300);
  if (shots) await message.screenshot({ path: join(shots, 'desktop-stack-hover.png') });
  await pile.click();
  await gallery(page).waitFor();
  assert.equal(await label(page), 'Picture 1, 1 of 3', 'from the first');
  await page.keyboard.press('End');
  assert.equal(await label(page), 'Picture 3, 3 of 3');
  await page.keyboard.press('Escape');
  await gallery(page).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'pic-pile', 'focus back on the pile');
  // A tool's two are a pile too.
  await page.locator('.tool-head').filter({ hasText: 'Screenshot' }).click();
  await page.locator('.tool-images .pic-pile').waitFor();
  assert.equal(await page.locator('.tool-images .pile-card').count(), 2);

  await page.evaluate(() => (location.hash = 'settings/appearance'));
  const setting = page.getByRole('radiogroup', { name: 'Pictures in messages' });
  await setting.waitFor();
  assert.equal(await setting.getByRole('radio', { name: 'Stack' }).getAttribute('aria-checked'), 'true', 'Stack unless you choose otherwise');
  await setting.getByRole('radio', { name: 'Grid' }).click();
  if (shots) await page.locator('.sec-card').filter({ has: setting }).screenshot({ path: join(shots, 'settings.png') });
  assert.equal(await page.evaluate(() => localStorage.getItem('ah.pictures')), 'grid', 'kept on this device');
  await page.evaluate((uid) => (location.hash = uid), uid);
  await message.waitFor();
  assert.equal(await message.locator('.pic').count(), 3, 'side by side now');
  assert.equal(await message.locator('.pic-pile').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});
