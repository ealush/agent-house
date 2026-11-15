// A sign-in in front of an agent's prompt, answered from the page: a real page →
// the card's rows, code and box → a stand-in that acts like a signed-out Codex.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser } from 'playwright-core';
import { startAh, cleanup, http, until, type Ah } from '../helpers.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const chrome = [process.env.AH_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome-stable'].find((p) => p && existsSync(p));
const skip = chrome ? false : 'no Chromium';
let ah: Ah;
let browser: Browser;
let scratch: string;
let log: string;

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(join(tmpdir(), 'ah-signin-'));
  const dist = join(scratch, 'dist');
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });
  const fixture = fileURLToPath(new URL('../fixtures/signin.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'ah-it-'));
  log = `${dir}/keys.log`;
  const saved = process.env.AH_DIST;
  process.env.AH_DIST = dist;
  try {
    ah = await startAh({ auth: { mode: 'off' }, idleAfter: 1, presets: [{ id: 'codex', name: 'Codex', command: `exec ${process.execPath} ${fixture} ${log}`, match: '^node$', feed: 'codex' }] }, dir);
  } finally {
    if (saved === undefined) delete process.env.AH_DIST;
    else process.env.AH_DIST = saved;
  }
  browser = await chromium.launch({ executablePath: chrome });
});

after(async () => {
  await browser?.close();
  if (ah) await cleanup(ah);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test('the page shows the sign-in, holds the message, and signs in through the card', { skip }, async () => {
  const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'codex', cwd: `${ah.dir}/files`, label: 'Sign-in test' } });
  assert.equal(created.status, 201, created.body);
  const { uid } = created.json();
  const win = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
  await until(async () => (await win())?.ask?.gate, 20_000, 'the sign-in shows as waiting');

  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
  await ctx.addInitScript(() => localStorage.setItem('ah.view', 'gui'));
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${ah.port}/#${uid}`);
  const card = page.locator('.gui .ask-panel');
  await card.getByText('Needs you to sign in').waitFor();
  assert.deepEqual(await card.locator('.ask-option .ask-label').allTextContents(), ['Sign in with ChatGPT', 'Sign in with Device Code', 'Provide your own API key']);
  assert.equal(await card.locator('.ask-option .ask-desc').first().textContent(), 'Usage included with Plus, Pro, Business, and Enterprise plans');

  // What's sent now waits in the tray, and the page says what for.
  const composer = page.getByRole('form', { name: 'Message composer' });
  await composer.getByRole('textbox', { name: 'Message', exact: true }).fill('Look at the failing test');
  await composer.getByRole('button', { name: 'Send', exact: true }).tap();
  await page.getByText("Your message goes in once you've signed in").waitFor();

  // The device code, in place, with its link.
  await card.locator('.ask-option', { hasText: 'Sign in with Device Code' }).click();
  await card.locator('.gate-code code').filter({ hasText: 'JUC6-GKWC4' }).waitFor();
  assert.equal(await card.getByRole('link', { name: 'Open the sign-in page' }).getAttribute('href'), 'https://auth.openai.com/codex/device');

  // Back, then the key, through the card's own box.
  await card.getByRole('button', { name: 'Back' }).click();
  await card.locator('.ask-option', { hasText: 'Provide your own API key' }).click();
  const box = card.locator('.gate-input input');
  await box.waitFor();
  assert.equal(await box.getAttribute('type'), 'password', 'a key shows as dots');
  await box.fill('sk-good');
  await card.getByRole('button', { name: 'Send' }).click();

  // Signed in: the held message goes in, whole.
  await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('PROMPT:Look at the failing test'), 15_000, 'the held message reached the prompt');
  await card.waitFor({ state: 'detached' });
  await ctx.close();
});
