// Settings → System → Developer in the real page: the host's log and this device's turned
// on, a message with a picture sent, then this device's log for the last 15 minutes sent
// to the host (where an agent reads it) and downloaded, and a range that ends before it
// starts refused. Desktop and phone, light and dark. AH_UI_SHOTS=<dir> saves screenshots.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser, type BrowserContextOptions, type Page } from 'playwright-core';
import { cleanup, http, until } from '../helpers.ts';
import { launch, startBed } from '../fake-agents.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHROME = [process.env.AH_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p): p is string => !!p && existsSync(p));
const skip = CHROME ? false : 'no Chromium or Chrome (set AH_CHROMIUM)';
const SHOTS = process.env.AH_UI_SHOTS;

let ah: Awaited<ReturnType<typeof startBed>>;
let browser: Browser;
let scratch: string;
let uid: string;

const lines = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const hostLog = () => {
  const dir = join(ah.dir, 'state', 'ah', 'logs');
  const day = existsSync(dir) ? execFileSync('ls', [dir], { encoding: 'utf8' }).trim().split('\n').at(-1) : null;
  const file = day ? join(dir, day, 'server.jsonl') : '';
  return file && existsSync(file) ? lines(file) : [];
};

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, name), fullPage: true });
}

async function open(options: BrowserContextOptions, hash: string, theme: 'light' | 'dark' = 'light') {
  for (const previous of browser.contexts()) await previous.close();
  const ctx = await browser.newContext({ ...options, acceptDownloads: true, colorScheme: theme });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((t) => (localStorage.setItem('ah.view', 'gui'), localStorage.setItem('ah.theme', t)), theme);
  await page.goto(`http://localhost:${ah.port}/#${hash}`, { waitUntil: 'domcontentloaded' });
  return { ctx, page, errors };
}

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(join(tmpdir(), 'ah-ui-'));
  let dist = process.env.AH_UI_DIST;
  if (!dist) {
    dist = join(scratch, 'dist');
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, stdio: 'inherit' });
  }
  ah = await startBed({}, { AH_DIST: dist, AH_USAGE: '0' });
  uid = (await launch(ah, 'claude', ah.project, 'Logged')).uid;
  browser = await chromium.launch({ executablePath: CHROME });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  if (skip) return;
  await browser?.close();
  if (ah) await cleanup(ah);
  rmSync(scratch, { recursive: true, force: true });
});

test('desktop: both logs on, a message with a picture, then the last 15 minutes sent to the host and downloaded', { skip, timeout: 120_000 }, async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1440, height: 1100 } }, 'settings/system');
  const card = page.locator('.sec-card', { has: page.getByRole('heading', { name: 'Developer' }) });
  await card.waitFor();
  const host = card.getByLabel('Keep a log on this host');
  assert.equal(await host.isChecked(), false, 'off until turned on');
  // Checked once the host says it's on.
  await host.click();
  await until(() => host.isChecked(), 5000, 'the switch shows the host log on');
  assert.equal((await http(ah, 'GET', '/api/system/logging')).json().server, true);
  const device = card.getByLabel('Keep a log on this device');
  await device.click();
  await until(() => device.isChecked(), 5000, 'the device log on');
  // Kept across a reload, which logs the page loading and its live connection opening.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await card.waitFor();
  assert.equal(await device.isChecked(), true);
  // The host's folder shows once the card has read the host's log status, after it mounts.
  await until(async () => /\.local\/state\/ah\/logs|state\/ah\/logs/.test(await card.innerText()), 5000, "the host log's folder");

  await page.evaluate((u) => (location.hash = `#${u}`), uid);
  const composer = page.getByRole('form', { name: 'Message composer' });
  await composer.waitFor();
  await composer.locator('input[type=file]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: Buffer.alloc(3000, 1) });
  await composer.locator('.composer-file:not(.uploading)').waitFor();
  await composer.getByRole('textbox', { name: 'Message', exact: true }).fill('What is in this picture?');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => hostLog().some((l) => l.kind === 'send' && l.ref === uid), 10_000, 'the host logged the send');
  const hostSend = hostLog().find((l) => l.kind === 'send' && l.ref === uid);
  assert.equal(hostSend.attachmentBytes, 3000, 'the host weighs the picture it was sent');
  assert.match(hostSend.text, /What is in this picture\?/);

  await page.evaluate(() => (location.hash = '#settings/system'));
  await card.waitFor();
  await card.getByRole('radio', { name: 'Last 15 minutes' }).click();
  assert.match(await card.innerText(), /[1-9][\d,]* of [\d,]+ entries in this time/);
  await card.getByLabel('Note').fill('The picture took a while');
  await shot(page, 'developer-desktop-light.png');
  await card.getByRole('button', { name: 'Send to host' }).click();
  const path = await card.locator('.bind-line code', { hasText: 'client-' }).innerText();
  assert.match(path, /client-\d{6}-web-[\w.-]+\.jsonl$/);
  const [header, ...entries] = lines(path);
  assert.equal(header.kind, 'bundle');
  assert.equal(header.app, 'web');
  assert.equal(header.note, 'The picture took a while');
  const send = entries.find((e) => e.kind === 'send');
  assert.equal(send.ref, uid);
  assert.equal(send.attachmentBytes, 3000, "the device knows the picture's size, and sends no bytes of it");
  assert.ok(entries.some((e) => e.kind === 'upload' && e.bytes === 3000));
  assert.ok(entries.some((e) => e.kind === 'request' && e.path === `/api/sessions/${uid}/send` && e.status === 200));
  assert.ok(entries.some((e) => e.kind === 'logging' && e.on === true));
  assert.ok(entries.some((e) => e.kind === 'page' && e.loaded));
  assert.ok(entries.some((e) => e.kind === 'stream' && e.phase === 'connected'));
  assert.ok(!entries.some((e) => e.path?.startsWith('/api/system/logging/client')), 'sending the log is not in it');
  assert.ok(hostLog().some((l) => l.kind === 'client-bundle' && l.file === path));
  await shot(page, 'developer-desktop-sent.png');

  const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: 'Download' }).click()]);
  assert.match(download.suggestedFilename(), /^ah-log-.+\.jsonl$/);
  const saved = lines(await download.path());
  assert.equal(saved[0].kind, 'bundle');
  assert.ok(saved[0].from && saved[0].to, 'the download says which time it covers');
  assert.ok(saved.some((e) => e.kind === 'send'));

  await card.getByRole('radio', { name: 'A range' }).click();
  await card.getByLabel('From', { exact: true }).fill('2026-11-22T10:00');
  await card.getByLabel('To', { exact: true }).fill('2026-11-22T09:00');
  assert.match(await card.innerText(), /The range ends before it starts/);
  assert.equal(await card.getByRole('button', { name: 'Send to host' }).isDisabled(), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone and dark: the Developer card fits, with nothing sideways', { skip, timeout: 60_000 }, async () => {
  for (const [name, options, theme] of [
    ['phone-light', devices['iPhone 15 Pro'], 'light'],
    ['phone-dark', devices['iPhone 15 Pro'], 'dark'],
    ['desktop-dark', { viewport: { width: 1440, height: 1100 } }, 'dark'],
  ] as const) {
    const { ctx, page, errors } = await open(options, 'settings/system', theme);
    await page.addInitScript(() => localStorage.setItem('ah.clientLog', '1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    const card = page.locator('.sec-card', { has: page.getByRole('heading', { name: 'Developer' }) });
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    await card.getByRole('radio', { name: 'A range' }).click();
    const width = page.viewportSize()!.width;
    const box = (await card.boundingBox())!;
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `${name}: the card fits`);
    for (const r of await card.getByRole('radio').all()) {
      const b = (await r.boundingBox())!;
      assert.ok(b.x + b.width <= box.x + box.width, `${name}: ${await r.getAttribute('aria-label')} sits inside the card`);
      assert.ok(b.height < 48, `${name}: ${await r.getAttribute('aria-label')} keeps to one line`);
    }
    assert.ok(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth + 1), `${name}: no sideways scroll`);
    await shot(page, `developer-${name}.png`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});
