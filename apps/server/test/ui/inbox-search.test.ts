// The Inbox's search, on a phone, in the real page: the tab bar is Inbox and Review; the
// Inbox's field lists every session and past conversation once it is focused, filters
// them as you type, opens a row, and the search is still there when you come back, as
// iOS's is, until Cancel puts the Inbox back. Stand-in agents (test/fake-agents.ts).
// AH_UI_SHOTS=<dir> saves screenshots.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser, type Page } from 'playwright-core';
import { cleanup, http, until } from '../helpers.ts';
import { launch, say, startBed, windows } from '../fake-agents.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHROME = [process.env.AH_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p): p is string => !!p && existsSync(p));
const skip = CHROME ? false : 'no Chromium or Chrome (set AH_CHROMIUM)';
const SHOTS = process.env.AH_UI_SHOTS;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, name) });
}

let ah: Awaited<ReturnType<typeof startBed>>;
let browser: Browser;
let scratch: string;

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(join(tmpdir(), 'ah-ui-'));
  let dist = process.env.AH_UI_DIST;
  if (!dist) {
    dist = join(scratch, 'dist');
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, stdio: 'inherit' });
  }
  ah = await startBed({}, { AH_DIST: dist });
  browser = await chromium.launch({ executablePath: CHROME });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  if (skip) return;
  await browser?.close();
  if (ah) await cleanup(ah);
  rmSync(scratch, { recursive: true, force: true });
});

test("phone: the Inbox's search lists sessions and History, filters, opens a row, and is still there on the way back", { skip, timeout: 120_000 }, async () => {
  // One past conversation, two live sessions.
  const ended = await launch(ah, 'claude', ah.project, 'Ship the parser');
  await say(ah, ended.uid, 'Rewrite the parser');
  await http(ah, 'POST', `/api/sessions/${ended.uid}/terminate`);
  await until(async () => !(await windows(ah)).some((w) => w.uid === ended.uid), 8000, 'ended');
  await launch(ah, 'claude', ah.project, 'Fix the login redirect');
  await launch(ah, 'codex', ah.project, 'Write the release notes');

  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${ah.port}/`, { waitUntil: 'networkidle' });
  await page.locator('.rows .row', { hasText: 'Fix the login redirect' }).waitFor();
  assert.deepEqual(await page.locator('.tabbar > button').allInnerTexts(), ['Inbox', 'Review']);
  // Not searching yet: the Inbox's own sections, and no History.
  assert.equal(await page.locator('.history-row').count(), 0);
  await page.waitForFunction(() => !document.documentElement.dataset.vt);

  const field = page.getByLabel('Search sessions and conversations');
  await field.tap();
  const lists = page.locator('.search-lists');
  await lists.locator('.section-label', { hasText: 'Sessions' }).waitFor();
  await lists.locator('.section-label', { hasText: 'History' }).waitFor();
  await lists.locator('.history-row', { hasText: 'Ship the parser' }).waitFor();
  await lists.locator('.rows .row', { hasText: 'Write the release notes' }).waitFor();
  await shot(page, 'inbox-search-phone-open.png');

  // Typing filters both lists.
  await field.fill('login');
  await lists.locator('.history-row', { hasText: 'Ship the parser' }).waitFor({ state: 'detached' });
  await lists.locator('.rows .row', { hasText: 'Write the release notes' }).waitFor({ state: 'detached' });
  const row = lists.locator('.rows .row', { hasText: 'Fix the login redirect' });
  await row.waitFor();
  await shot(page, 'inbox-search-phone-typed.png');

  // A row opens its session; Back comes back to the same search.
  await row.tap();
  await page.waitForFunction(() => location.hash.length > 1);
  await page.getByRole('button', { name: /back/i }).first().tap();
  await page.locator('h1.page-title', { hasText: 'Inbox' }).waitFor();
  assert.equal(await field.inputValue(), 'login');
  await lists.locator('.rows .row', { hasText: 'Fix the login redirect' }).waitFor();
  assert.equal(await lists.locator('.rows .row', { hasText: 'Write the release notes' }).count(), 0);

  // Cancel puts the Inbox back as it was.
  await page.waitForFunction(() => !document.documentElement.dataset.vt);
  await page.getByRole('button', { name: 'Cancel' }).tap();
  await page.locator('.search-lists').waitFor({ state: 'detached' });
  assert.equal(await field.inputValue(), '');
  await page.locator('.rows .row', { hasText: 'Write the release notes' }).waitFor();
  assert.equal(await page.locator('.history-row').count(), 0);

  // An empty field let go of leaves search too, but a press on a row still opens it.
  await field.tap();
  await lists.waitFor();
  await lists.locator('.rows .row', { hasText: 'Write the release notes' }).tap();
  await page.waitForFunction(() => location.hash.length > 1);
  await page.getByRole('button', { name: /back/i }).first().tap();
  await page.locator('h1.page-title', { hasText: 'Inbox' }).waitFor();
  await lists.waitFor();
  await page.waitForFunction(() => !document.documentElement.dataset.vt);
  await field.tap();
  await page.locator('h1.page-title').tap();
  await lists.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await ctx.close();
});
