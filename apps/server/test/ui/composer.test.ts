// Real page → HTTP send/upload → disposable host → transcript fixture. No production state.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, devices, type Browser, type BrowserContextOptions } from 'playwright-core';
import { startAh, cleanup, http, until, type Ah } from '../helpers.ts';
import { readPixels } from './paint.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const chrome = [process.env.AH_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome-stable'].find((p) => p && existsSync(p));
const webkitPath = process.env.AH_COMPOSER_WEBKIT;
const skip = chrome || webkitPath ? false : 'no Chromium or WebKit';
const shots = process.env.AH_COMPOSER_SHOTS;
let ah: Ah;
let browser: Browser;
let scratch: string;
let uid: string;

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(join(tmpdir(), 'ah-composer-'));
  const runner = join(scratch, 'agent.mjs');
  const fixture = new URL('../fixtures/transcript-agent.js', import.meta.url).href;
  // Behave normally until the queue test asks this same, already adopted agent to work.
  writeFileSync(runner, `import ${JSON.stringify(fixture)};\nlet input = '', working = false;\nprocess.stdin.on('data', (chunk) => {\n  input += chunk.toString();\n  if (!working && input.includes('BEGIN_COMPOSER_WORK')) {\n    working = true;\n    setInterval(() => console.log('Working', Date.now()), 100);\n  }\n});\n`);
  // For New session, which offers only what's on the host to launch (an "exec …" command isn't).
  const idle = join(scratch, 'idle.mjs');
  writeFileSync(idle, 'setInterval(() => {}, 1 << 30);\n');
  const dist = join(scratch, 'dist');
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });
  const saved = process.env.AH_DIST;
  process.env.AH_DIST = dist;
  try {
    ah = await startAh({ auth: { mode: 'off' }, idleAfter: 1, presets: [{
      id: 'claude', name: 'Composer test', command: `exec ${process.execPath} ${runner}`,
      match: '^node$', feed: 'claude', models: [{ id: 'sonnet', name: 'Sonnet', args: [], isDefault: true }],
      modelArgs: ['--model', '{model}'], effort: { args: ['--effort', '{level}'], levels: ['medium', 'high'] },
      modes: [{ id: 'default', name: 'Ask before changes' }, { id: 'plan', name: 'Plan', args: [] }],
    }, { id: 'starter', name: 'Starter', command: `${process.execPath} ${idle}`, match: '^never-detected$' }] });
  } finally {
    if (saved === undefined) delete process.env.AH_DIST;
    else process.env.AH_DIST = saved;
  }
  const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'claude', cwd: `${ah.dir}/files`, label: 'Composer test' } });
  assert.equal(created.status, 201, created.body);
  uid = created.json().uid;
  await until(async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid && w.harnessId && ['idle', 'attention'].includes(w.status)), 20_000, 'ready transcript fixture');
  browser = webkitPath ? await webkit.launch({ executablePath: webkitPath }) : await chromium.launch({ executablePath: chrome });
  if (shots) mkdirSync(shots, { recursive: true });
});

after(async () => {
  await browser?.close();
  if (ah) await cleanup(ah);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function open(options: BrowserContextOptions, target = uid, theme: 'light' | 'dark' = 'light') {
  // A preceding assertion failure must not leave an old page attached to the host.
  for (const previous of browser.contexts()) await previous.close();
  const ctx = await browser.newContext(options);
  const errors: string[] = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((theme) => { localStorage.setItem('ah.view', 'gui'); localStorage.setItem('ah.theme', theme); }, theme);
  // The app keeps live streams open; readiness is the composer, not network silence.
  await page.goto(`http://localhost:${ah.port}/#${target}`, { waitUntil: 'domcontentloaded' });
  const composer = page.getByRole('form', { name: 'Message composer' });
  try {
    await composer.waitFor();
  } catch (e) {
    console.error('Composer failed to open:', await page.locator('body').innerText(), errors);
    if (shots) await page.screenshot({ path: join(shots, 'open-failure.png'), timeout: 5000 });
    throw e;
  }
  return { ctx, page, composer, input: composer.getByRole('textbox', { name: 'Message', exact: true }), errors };
}

test('mobile: a stable toolbar fits narrow phones, landscape and iPad; drafts grow without moving Send', { skip, timeout: 90_000 }, async () => {
  for (const [name, options] of [
    ['phone', devices['iPhone 15 Pro']],
    ['small-phone', { ...devices['iPhone SE'], viewport: { width: 320, height: 640 } }],
    ['landscape', devices['iPhone 15 Pro landscape']],
    ['ipad', devices['iPad Pro 11']],
  ] as const) {
    const { ctx, page, composer, input, errors } = await open(options);
    assert.equal(await composer.locator('.tool-chip').count(), 0, 'settings do not compete with the draft');
    const action = composer.locator('.send-btn');
    const initial = (await action.boundingBox())!;
    await input.fill('A longer message\nwith room to think\nand a third line.');
    const after = (await action.boundingBox())!;
    assert.ok(Math.abs(initial.x - after.x) < 1, 'Send stays in the same column');
    assert.ok(Math.abs(initial.y - after.y) < 1, 'the composer grows upward while Send stays anchored');
    const box = (await composer.boundingBox())!;
    assert.ok(box.x >= 0 && box.x + box.width <= page.viewportSize()!.width, `${name}: composer fits`);
    assert.ok(after.width >= 44 && after.height >= 44, 'Send is a full touch target');
    assert.ok((await input.boundingBox())!.height >= 72, 'multiline input grows');
    await input.fill(Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join('\n'));
    const height = await input.evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight, max: innerHeight * .28 }));
    assert.ok(height.height <= height.max + 2 && height.scroll > height.height, 'long drafts scroll within a bounded input');
    await input.fill('');
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test('phone: Return makes a paragraph; Send reaches the host once and keeps editing focus', { skip, timeout: 60_000 }, async () => {
  const { ctx, page, composer, input, errors } = await open(devices['iPhone 15 Pro']);
  const sends: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/send$/.test(r.url())) sends.push(r.postDataJSON().text); });
  await input.fill('First paragraph');
  await input.press('Enter');
  assert.equal(await input.inputValue(), 'First paragraph\n');
  assert.deepEqual(sends, [], 'Return does not send on the software keyboard');
  await input.fill('A message from the phone');
  await input.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true })));
  assert.deepEqual(sends, [], 'IME confirmation never sends');
  await composer.getByRole('button', { name: 'Send', exact: true }).tap();
  try {
    await until(() => sends.length === 1, 5000, 'one send request');
  } catch (e) {
    if (shots) await page.screenshot({ path: join(shots, 'send-failure.png') });
    console.error('Send failure:', await composer.evaluate((el) => ({ html: el.outerHTML, active: document.activeElement?.outerHTML })), errors);
    throw e;
  }
  assert.deepEqual(sends, ['A message from the phone']);
  assert.equal(await input.inputValue(), '');
  assert.equal(await input.evaluate((el) => el === document.activeElement), true, 'Send keeps the writing focus');
  await until(() => ah.tmux('capture-pane', '-p', '-t', 'it:').includes('RECEIVED:A message from the phone'), 8000, 'message arrives in the fixture');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('touch: settings are a sheet with Back on phones, landscape and iPad; drafts stay intact', { skip, timeout: 60_000 }, async () => {
  for (const [name, options] of [['phone', devices['iPhone 15 Pro']], ['landscape', devices['iPhone 15 Pro landscape']], ['ipad', devices['iPad Pro 11']]] as const) {
    const { ctx, page, composer, input, errors } = await open(options);
    await input.fill('Keep this draft while choosing settings');
    await composer.getByRole('button', { name: /^Session settings:/ }).tap();
    const sheet = page.getByRole('dialog', { name: 'Session settings', exact: true });
    await sheet.waitFor();
    // Wait for the real sheet's entrance animation, not a fixed delay.
    await sheet.screenshot(shots ? { path: join(shots, `${name}-settings-open.png`) } : {});
    const box = (await sheet.boundingBox())!;
    assert.ok(box.y > 0 && box.y + box.height <= page.viewportSize()!.height + 1, `sheet is bounded by the screen: ${JSON.stringify(box)}`);
    await sheet.getByRole('button', { name: /^Reasoning effort/ }).tap();
    assert.equal(await sheet.locator('.sheet-title').innerText(), 'Reasoning effort');
    await sheet.getByRole('button', { name: 'Back to Session settings' }).tap();
    await page.waitForFunction(() => {
      const title = document.querySelector('.composer-options .sheet-title');
      return title && getComputedStyle(title).opacity === '1';
    });
    if (shots) await page.screenshot({ path: join(shots, `${name}-settings.png`) });
    await sheet.getByRole('button', { name: /^Close(?: session settings)?$/ }).tap();
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await input.inputValue(), 'Keep this draft while choosing settings');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test('phone: add menu uploads a real file, and failed sends return text and attachments', { skip, timeout: 60_000 }, async () => {
  const { ctx, page, composer, input, errors } = await open(devices['iPhone 15 Pro']);
  await composer.getByRole('button', { name: 'Add to message', exact: true }).tap();
  await composer.getByRole('button', { name: 'Attach files', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await composer.locator('input[type=file]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('A real upload in a disposable host.') });
  await composer.locator('.composer-file:not(.uploading)').waitFor();
  await input.fill('Send with the attachment');
  await page.route('**/api/sessions/*/send', (route) => route.abort('failed'));
  await composer.getByRole('button', { name: 'Send', exact: true }).tap();
  await page.getByRole('dialog').filter({ hasText: "Couldn't send" }).waitFor();
  assert.equal(await input.inputValue(), 'Send with the attachment');
  assert.equal(await composer.locator('.composer-file').count(), 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

/**
 * How much of the text in `clip` differs between two looks of the page (styles applied in
 * turn), as they are and with one moved a device pixel. A run of text can antialias a letter
 * its own way, so "the same" is: much closer than a pixel off would be.
 */
async function differing(page: import('playwright-core').Page, clip: { x: number; y: number; width: number; height: number }, a: string, b: string, save?: string) {
  let n = 0;
  const shot = async (css: string) => {
    const style = await page.addStyleTag({ content: css });
    const png = await page.screenshot({ clip, animations: 'disabled', caret: 'hide', ...(save ? { path: `${save}-${++n}.png` } : {}) });
    await style.evaluate((el) => el.remove());
    return `data:image/png;base64,${png.toString('base64')}`;
  };
  const [one, two] = [await shot(a), await shot(b)];
  return page.evaluate(async ([one, two]) => {
    const read = async (src: string) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, img.width, img.height).data;
    };
    const [x, y] = [await read(one), await read(two)];
    const img = new Image(); img.src = one; await img.decode();
    const w = img.width, h = img.height;
    const far = (i: number, j: number) => Math.abs(x[i] - y[j]) + Math.abs(x[i + 1] - y[j + 1]) + Math.abs(x[i + 2] - y[j + 2]) > 48;
    const inked = (i: number) => Math.abs(x[i] - x[0]) + Math.abs(x[i + 1] - x[1]) + Math.abs(x[i + 2] - x[2]) > 48;
    // Of the pixels the text inks, how many differ with the second look moved by (dx, dy).
    const off = (dx: number, dy: number) => {
      let ink = 0, n = 0;
      for (let py = 1; py < h - 1; py++) for (let px = 1; px < w - 1; px++) {
        const i = (py * w + px) * 4;
        if (!inked(i)) continue;
        ink++;
        if (far(i, ((py + dy) * w + px + dx) * 4)) n++;
      }
      return n / Math.max(1, ink);
    };
    return { aligned: off(0, 0), shifted: Math.min(off(1, 0), off(-1, 0), off(0, 1), off(0, -1)) };
  }, [one, two]);
}

for (const [name, options] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['phone', devices['iPhone 15 Pro']]] as const) {
  test(`${name}: an @file is a chip in the box that opens the file, and its × takes it out`, { skip, timeout: 60_000 }, async () => {
    mkdirSync(join(ah.dir, 'files', 'src'), { recursive: true });
    writeFileSync(join(ah.dir, 'files', 'notes.md'), '# Notes\nhello from the notes\n');
    writeFileSync(join(ah.dir, 'files', 'src', 'app.ts'), 'export const app = 1;\n');
    const { ctx, page, composer, input, errors } = await open(options);
    // Long enough to wrap, so the layer has to break its lines where the box does.
    const draft = 'Read @notes.md and compare it with @src/app.ts, then tell @nobody what changed and why it matters for the next release';
    await input.fill(draft);
    const chips = composer.locator('.mention-chip');
    await until(async () => (await chips.count()) === 2, 8000, 'two chips');
    assert.deepEqual(await chips.allTextContents(), ['@notes.md', '@src/app.ts'], 'a name that is no file stays text');
    await input.blur();
    // The layer's letters lie on the box's own: drawn either way, the line looks the same.
    const box = (await composer.locator('.composer-input').boundingBox())!;
    const off = await differing(page, box,
      '.mention-layer { visibility: hidden } .composer textarea.has-mentions { color: var(--text) !important; -webkit-text-fill-color: var(--text) !important }',
      '.mention-chip { color: inherit !important; background: none !important; box-shadow: none !important; outline: none !important } .mention-x { color: inherit !important } .mention-x svg { display: none !important }', shots && join(shots, `${name}-align`));
    assert.ok(off.aligned < off.shifted / 3, `layer and box text line up (${(off.aligned * 100).toFixed(1)}% of the text differs; ${(off.shifted * 100).toFixed(1)}% a pixel off)`);
    if (shots) await composer.screenshot({ path: join(shots, `${name}-mentions.png`) });

    // On its name: the × is where its @ was.
    const first = (await chips.first().boundingBox())!;
    await chips.first().click({ position: { x: first.width - 8, y: first.height / 2 } });
    const sheet = page.getByRole('dialog', { name: 'notes.md' });
    await sheet.waitFor();
    await until(async () => (await sheet.locator('pre').innerText().catch(() => '')).includes('hello from the notes'), 8000, 'the file in the preview');
    if (shots) await page.screenshot({ path: join(shots, `${name}-mention-preview.png`) });
    await sheet.getByRole('button', { name: /^Close/ }).first().click();
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await input.inputValue(), draft, 'opening it leaves the text alone');

    await composer.getByRole('button', { name: 'Remove src/app.ts' }).click();
    assert.equal(await input.inputValue(), 'Read @notes.md and compare it with, then tell @nobody what changed and why it matters for the next release');
    assert.deepEqual(await chips.allTextContents(), ['@notes.md']);
    // Still typing a mention: not a chip until the completion lets go of it.
    await input.fill('Look at @notes.md');
    await input.press('End');
    await page.waitForTimeout(300);
    assert.equal(await chips.count(), 0, 'the mention under the caret is still being written');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('phone: an @file in a sent message is a chip in the feed that opens the file; in code it stays code', { skip, timeout: 60_000 }, async () => {
  writeFileSync(join(ah.dir, 'files', 'feed-notes.md'), 'notes for the feed\n');
  const sent = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'Check @feed-notes.md and `@feed-notes.md` please' } });
  assert.equal(sent.status, 200, sent.body);
  const { ctx, page, errors } = await open(devices['iPhone 15 Pro']);
  const bubble = page.locator('.msg.user').filter({ hasText: 'Check @feed-notes.md' }).last();
  await bubble.waitFor();
  const chip = bubble.locator('a.mention-chip');
  await until(async () => (await chip.count()) === 1, 8000, 'the mention as a chip');
  assert.equal(await chip.textContent(), '@feed-notes.md');
  assert.equal(await bubble.locator('code').textContent(), '@feed-notes.md', 'in code it stays code');
  if (shots) await bubble.screenshot({ path: join(shots, 'phone-feed-mention.png') });
  await chip.click();
  const sheet = page.getByRole('dialog', { name: 'feed-notes.md' });
  await sheet.waitFor();
  await until(async () => (await sheet.locator('pre').innerText().catch(() => '')).includes('notes for the feed'), 8000, 'the file in the preview');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('desktop: an attached picture is a tile and a chip where the caret was; it goes in that place and shows there in the feed', { skip, timeout: 60_000 }, async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
  const { ctx, page, composer, input, errors } = await open({ viewport: { width: 1440, height: 900 } });
  await input.fill('Look at  and tell me');
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(8, 8));
  await composer.locator('input[type=file]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png });
  await composer.locator('.composer-file.image:not(.uploading)').waitFor();
  assert.equal(await input.inputValue(), 'Look at @shot.png and tell me', 'in at the caret, a space each side');
  const chip = composer.locator('.mention-chip.attached');
  await chip.waitFor();
  assert.equal(await chip.textContent(), '@shot.png');
  if (shots) await composer.screenshot({ path: join(shots, 'desktop-attached-chip.png') });
  // Its tile's × takes the chip out too.
  await composer.locator('input[type=file]').setInputFiles({ name: 'other.png', mimeType: 'image/png', buffer: png });
  await until(async () => (await input.inputValue()).includes('@other.png'), 8000, 'the second chip');
  await composer.getByRole('button', { name: 'Remove other.png' }).first().click();
  assert.equal(await input.inputValue(), 'Look at @shot.png and tell me');
  assert.equal(await composer.locator('.composer-file').count(), 1);

  const response = page.waitForResponse((r) => /\/send$/.test(r.url()) && r.request().method() === 'POST');
  await input.press('Enter');
  const sent = (await response).request().postDataJSON().text as string;
  assert.match(sent, /^Look at \/\S+\/ah\/uploads\/\S+-shot\.png and tell me$/, 'the path where the chip was');
  const bubble = page.locator('.msg.user').filter({ hasText: 'and tell me' }).last();
  await bubble.locator('.user-images img').waitFor();
  const inFeed = bubble.locator('a.mention-chip');
  await inFeed.waitFor();
  assert.equal(await inFeed.textContent(), '@shot.png');
  assert.equal((await bubble.locator('.md').innerText()).trim(), 'Look at @shot.png and tell me', 'in its place in the words');
  if (shots) await bubble.screenshot({ path: join(shots, 'desktop-attached-feed.png') });
  assert.deepEqual(errors, []);
  await ctx.close();
});

for (const [name, options] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['phone', devices['iPhone 15 Pro']]] as const) {
  test(`${name}: a chip drags to another place in the text, and a drag doesn't open it`, { skip, timeout: 60_000 }, async () => {
    writeFileSync(join(ah.dir, 'files', 'notes.md'), '# Notes\n');
    const { ctx, page, composer, input, errors } = await open(options);
    const chip = composer.locator('.mention-chip');
    // The last test's draft can still arrive from the host: this one's text, and only its chip.
    await until(async () => {
      if ((await input.inputValue()) !== 'Read @notes.md and then compare with src') await input.fill('Read @notes.md and then compare with src');
      return (await chip.count()) === 1 && (await input.inputValue()) === 'Read @notes.md and then compare with src';
    }, 8000, 'the draft with one chip');
    await input.blur();
    const from = (await chip.boundingBox())!;
    // The end of the text, in the layer that draws it.
    const to = await composer.locator('.mention-layer').evaluate((layer) => {
      const range = document.createRange();
      range.selectNodeContents(layer);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      const last = rects[rects.length - 1];
      return { x: last.right - 1, y: last.top + last.height / 2 };
    });
    const start = { x: from.x + from.width - 6, y: from.y + from.height / 2 };
    // A finger through Chromium's touch input; WebKit has none to drive, so a pointer there.
    if (name === 'desktop' || webkitPath) {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(start.x + ((to.x - start.x) * i) / 8, start.y + ((to.y - start.y) * i) / 8);
      if (shots) await page.screenshot({ path: join(shots, 'desktop-drag.png') });
      await page.mouse.up();
    } else {
      // A finger: touch events, which the page sees as a touch pointer.
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start.x, y: start.y }] });
      for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + ((to.x - start.x) * i) / 8, y: start.y + ((to.y - start.y) * i) / 8 }] });
      if (shots) await page.screenshot({ path: join(shots, 'phone-drag.png') });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await until(async () => (await input.inputValue()) !== 'Read @notes.md and then compare with src', 4000, 'the chip moved');
    assert.equal(await input.inputValue(), 'Read and then compare with src @notes.md ');
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole('dialog', { name: 'notes.md' }).count(), 0, 'a drag is not a tap');
    assert.equal(await chip.count(), 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('desktop: chips and Enter-to-send remain, and recall returns to the unsent draft', { skip, timeout: 60_000 }, async () => {
  // Give recall a real host-side prompt, also when this test runs on its own.
  const earlier = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'Earlier prompt' } });
  assert.equal(earlier.status, 200, earlier.body);
  const { ctx, page, composer, input, errors } = await open({ viewport: { width: 1440, height: 900 } });
  assert.equal(await composer.locator('.tool-chip').count(), 3);
  assert.equal(await composer.locator('.composer-add').count(), 0);
  await input.fill('Draft before history');
  await composer.getByRole('button', { name: 'Previous message', exact: true }).click();
  assert.notEqual(await input.inputValue(), 'Draft before history');
  await input.press('ArrowDown');
  assert.equal(await input.inputValue(), 'Draft before history');
  await input.fill('Desktop keyboard send');
  const response = page.waitForResponse((r) => /\/send$/.test(r.url()) && r.request().method() === 'POST');
  await input.press('Enter');
  assert.equal((await response).ok(), true);
  assert.equal(await input.inputValue(), '');
  if (shots) await page.screenshot({ path: join(shots, 'desktop.png') });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('mobile: real conversation scrolls behind glass; growing drafts and a keyboard keep messages reachable', { skip, timeout: 60_000 }, async () => {
  const text = 'Mobile glass scroll check. ' + 'Keep the conversation readable while the controls float above it. '.repeat(100);
  ah.tmux('send-keys', '-t', 'it:', '-l', text);
  ah.tmux('send-keys', '-t', 'it:', 'Enter');
  for (const [name, options] of [['phone', devices['iPhone 15 Pro']], ['ipad', devices['iPad Pro 11']]] as const) {
    const { ctx, page, composer, input, errors } = await open(options);
    const scroll = page.locator('.gui-scroll');
    const feed = page.locator('.gui-feed');
    const header = page.locator('.mobile-session-chrome');
    const dock = page.locator('.mobile-composer-dock');
    await page.waitForFunction(() => {
      const el = document.querySelector('.gui-scroll')!;
      return el.scrollHeight > el.clientHeight * 2;
    });
    const top = (await header.boundingBox())!;
    const viewport = (await scroll.boundingBox())!;
    assert.ok(viewport.y < top.y + top.height, 'the actual feed extends behind the header');
    const field = (await composer.boundingBox())!;
    assert.ok(viewport.y + viewport.height > field.y + field.height - 1, 'the actual feed extends behind the composer');
    assert.match(await composer.evaluate((el) => getComputedStyle(el, '::before').backdropFilter), /blur\(/);
    await scroll.evaluate((el) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * .4; });
    await page.locator('.gui-latest').waitFor();
    const reading = await scroll.evaluate((el) => el.scrollTop);
    await input.fill('A draft with room to think.\n'.repeat(15));
    await page.waitForFunction(() => {
      const dock = document.querySelector('.mobile-composer-dock')!;
      const feed = document.querySelector('.gui-feed')!;
      return parseFloat(getComputedStyle(feed).paddingBottom) >= dock.getBoundingClientRect().height;
    });
    assert.ok(Math.abs(await scroll.evaluate((el) => el.scrollTop) - reading) < 2, 'growing the draft keeps the reading position');
    const latest = (await page.locator('.gui-latest').boundingBox())!;
    assert.ok(latest.y + latest.height < (await dock.boundingBox())!.y, 'Latest stays above the writing surface');
    if (shots) await page.screenshot({ path: join(shots, `${name}-floating-glass.png`) });
    await page.locator('.gui-latest').tap();
    await until(async () => scroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop < 2), 5000, 'latest message reached').catch(async (e) => {
      console.error('Latest geometry:', name, await scroll.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight })), await page.evaluate(() => document.activeElement?.tagName));
      if (shots) await page.screenshot({ path: join(shots, `${name}-latest-failure.png`) });
      throw e;
    });
    const last = (await feed.locator('.msg').last().boundingBox())!;
    assert.ok(last.y + last.height <= (await dock.boundingBox())!.y, 'last message clears the composer');
    await input.fill('');

    await scroll.evaluate((el) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * .4; });
    await page.locator('.gui-latest').waitFor();
    const textBox = (await composer.boundingBox())!;
    const textPoints = Array.from({ length: 80 }, (_, i) => ({ x: textBox.x + textBox.width * .4 + (i % 20) * textBox.width * .025, y: textBox.y + 8 + Math.floor(i / 20) * 6 }));
    const textBlurred = await readPixels(page, textPoints);
    await composer.evaluate((el) => el.style.setProperty('--glass-blur', 'none'));
    const textSharp = await readPixels(page, textPoints);
    const textDelta = textBlurred.reduce((sum, rgb, i) => sum + rgb.reduce((s, n, channel) => s + Math.abs(n - textSharp[i][channel]), 0), 0) / (textPoints.length * 3);
    assert.ok(textDelta > 1, `${name}: the real transcript's lettering is softened under the composer (pixel delta ${textDelta.toFixed(2)})`);
    await composer.evaluate((el) => el.style.removeProperty('--glass-blur'));

    // A controlled paint probe in the REAL app tree catches ancestor captures
    // or masks blocking blur. Preserve the transcript's layout, then restore it.
    const probe = await page.addStyleTag({ content: '.gui-feed > * { visibility: hidden !important; } .gui-scroll { background: repeating-linear-gradient(90deg, #000 0 4px, #fff 4px 8px); }' });
    const h = (await header.boundingBox())!;
    const c = (await composer.boundingBox())!;
    const points = [{ x: h.x + h.width / 2, y: h.y + h.height - 4 }, { x: c.x + c.width / 2, y: c.y + 12 }];
    const filtered = await readPixels(page, points);
    await header.evaluate((el) => el.style.setProperty('--glass-blur', 'none'));
    await composer.evaluate((el) => el.style.setProperty('--glass-blur', 'none'));
    const sharp = await readPixels(page, points);
    for (let i = 0; i < points.length; i++) assert.ok(Math.max(...filtered[i].map((n, channel) => Math.abs(n - sharp[i][channel]))) >= 12, `${name}: ${i === 0 ? 'header' : 'composer'} blurs the real feed (${filtered[i]} vs ${sharp[i]})`);
    await header.evaluate((el) => el.style.removeProperty('--glass-blur'));
    await composer.evaluate((el) => el.style.removeProperty('--glass-blur'));
    await probe.evaluate((el) => el.remove());

    if (name === 'phone') {
      // Exercise the real viewport tracker with a controlled visual viewport;
      // this checks geometry, not an actual iOS keyboard or PWA compositor.
      await input.focus();
      await page.evaluate(() => {
        Object.defineProperty(visualViewport, 'height', { configurable: true, value: 360 });
        visualViewport!.dispatchEvent(new Event('resize'));
      });
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-keyboard') && getComputedStyle(document.querySelector('.mobile-session-chrome .seg-tabs')!).display === 'none');
      await page.waitForFunction(() => {
        const h = document.querySelector('.mobile-session-chrome')!.getBoundingClientRect();
        const d = document.querySelector('.mobile-composer-dock')!.getBoundingClientRect();
        return d.bottom <= 361 && d.top >= h.bottom;
      });
      if (shots) await page.screenshot({ path: join(shots, 'phone-keyboard-geometry.png') });
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test('phone: a working agent offers Queue, and the follow-up really enters its queue', { skip, timeout: 60_000 }, async () => {
  // Start actual output in the fixture; the follow-up itself must go through the UI/API.
  ah.tmux('send-keys', '-t', 'it:', '-l', 'BEGIN_COMPOSER_WORK');
  ah.tmux('send-keys', '-t', 'it:', 'Enter');
  await until(async () => (await http(ah, 'GET', '/api/state')).json().windows.some((w: any) => w.uid === uid && w.status === 'busy') && ah.tmux('capture-pane', '-p', '-t', 'it:').includes('Working'), 8000, 'working transcript fixture');
  assert.equal((await http(ah, 'DELETE', `/api/sessions/${uid}/queue`)).status, 200);
  const { ctx, page, composer, input, errors } = await open(devices['iPhone 15 Pro'], uid, 'dark');
  const followUp = 'A follow-up for after this response';
  await input.fill(followUp);
  const queue = composer.getByRole('button', { name: 'Queue', exact: true });
  await queue.waitFor();
  if (shots) await page.screenshot({ path: join(shots, 'phone-queue-dark.png') });
  await queue.tap();
  const queued = await until(async () => {
    const items = (await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json();
    return items.some((item: any) => item.text === followUp) ? items : null;
  }, 8000, 'this follow-up appears in the real queue');
  assert.equal(queued.length, 1);
  assert.equal(await input.inputValue(), '');
  await composer.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: a queued message edited and queued again goes back to its place', { skip, timeout: 60_000 }, async () => {
  const busy = async () => (await http(ah, 'GET', '/api/state')).json().windows.some((w: any) => w.uid === uid && w.status === 'busy');
  if (!(await busy())) {
    ah.tmux('send-keys', '-t', 'it:', '-l', 'BEGIN_COMPOSER_WORK');
    ah.tmux('send-keys', '-t', 'it:', 'Enter');
    await until(busy, 8000, 'working transcript fixture');
  }
  assert.equal((await http(ah, 'DELETE', `/api/sessions/${uid}/queue`)).status, 200);
  for (const text of ['first', 'second', 'third']) {
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text } })).json().outcome, 'queued');
  }
  const { ctx, page, composer, input, errors } = await open(devices['iPhone 15 Pro'], uid, 'dark');
  const tray = page.getByRole('list', { name: 'Queued messages' });
  await tray.getByRole('listitem').filter({ hasText: 'third' }).waitFor();
  await tray.getByRole('listitem').filter({ hasText: 'second' }).getByRole('button', { name: 'Edit', exact: true }).tap();
  await until(async () => (await input.inputValue()) === 'second', 5000, 'the middle one back in the box');
  await input.fill('second, reworded');
  if (shots) await page.screenshot({ path: join(shots, 'phone-queue-edit.png') });
  await composer.getByRole('button', { name: 'Queue', exact: true }).tap();
  const placed = JSON.stringify(['first', 'second, reworded', 'third']);
  let order = '';
  await until(async () => (order = JSON.stringify((await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json().map((q: any) => q.text))) === placed, 8000, 'back in its place')
    .catch(() => assert.fail(`the queue reads ${order}`));
  await until(async () => JSON.stringify((await tray.getByRole('listitem').allInnerTexts()).map((r) => r.split('\n')[0].trim())) === placed, 8000, 'the tray shows it in its place');
  if (shots) await page.screenshot({ path: join(shots, 'phone-queue-edit-placed.png') });
  assert.deepEqual(errors, []);
  await ctx.close();
});

// Last: it opens a window in the test's tmux session, which the tests above type into as "it:".
test('desktop: New session takes files for its first message, uploaded before the session exists', { skip, timeout: 60_000 }, async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 900 } });
  await page.keyboard.press('Control+Shift+Enter');
  const dialog = page.locator('.new-session');
  await dialog.locator('#ns-prompt').waitFor();
  await dialog.getByRole('button', { name: 'Attach files', exact: true }).waitFor();
  await dialog.locator('.ns-prompt input[type=file]').setInputFiles({ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Notes for the new session.') });
  // On the host already, with no session yet: the tile's title is where it landed.
  await dialog.locator('.composer-file:not(.uploading)').waitFor();
  const path = await dialog.locator('.composer-file').getAttribute('title');
  assert.match(path ?? '', /\/ah\/uploads\/\S*brief\.txt$/);
  // A chip in the prompt where it was put, as in a session's box.
  assert.equal(await dialog.locator('#ns-prompt').inputValue(), '@brief.txt ');
  await dialog.locator('.mention-chip').filter({ hasText: '@brief.txt' }).waitFor();
  await dialog.locator('#ns-prompt').fill('Read @brief.txt first');
  if (shots) await page.screenshot({ path: join(shots, 'new-session-attached.png') });
  const sent = page.waitForRequest((r) => /\/api\/sessions\/[^/]+\/send$/.test(r.url()) && r.method() === 'POST');
  await dialog.getByRole('button', { name: /^Start/ }).click();
  const body = JSON.parse((await sent).postData() ?? '{}');
  assert.equal(body.text, `Read ${path} first`, 'the first message carries the file where its chip was');
  assert.deepEqual(errors, []);
  await ctx.close();
});
