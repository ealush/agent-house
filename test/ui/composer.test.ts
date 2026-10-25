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

const root = fileURLToPath(new URL('../..', import.meta.url));
const chrome = [process.env.AH_CHROMIUM, '/usr/bin/chromium', '/usr/bin/google-chrome-stable'].find((p) => p && existsSync(p));
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
    }] });
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
