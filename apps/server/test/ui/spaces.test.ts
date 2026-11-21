// Spaces in the real page (web/Inbox.tsx's menu, web/SpaceDialogs.tsx, web/SpacesSettings.tsx)
// against a real host (docs/spec/17-spaces.md): New Space from the Inbox's title, shown at
// once though it's empty; its preferences and memory edited in Space settings and written
// on the host; Remove, said before it's done, takes it off the menu; Settings → Spaces puts
// it back. A phone's menu is an action sheet with the same entries. AH_UI_SHOTS=<dir> saves
// screenshots.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser, type Page } from 'playwright-core';
import { cleanup, http, until } from '../helpers.ts';
import { launch, startBed } from '../fake-agents.ts';

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

const list = async () => (await http(ah, 'GET', '/api/spaces')).json();

test('desktop: New Space from the Inbox, its preferences and memory, Remove, and Restore from Settings', { skip, timeout: 150_000 }, async () => {
  // A repository Space with a session in it, so the menu has more than the new one.
  await launch(ah, 'claude', ah.project, 'Release notes');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${ah.port}/`, { waitUntil: 'networkidle' });

  const title = page.locator('button.title-pick');
  await title.click();
  const menu = page.getByRole('menu', { name: 'Show sessions from' });
  await menu.getByRole('menuitemradio', { name: 'All Spaces' }).waitFor();
  await menu.getByRole('menuitemradio', { name: 'proj' }).waitFor();
  await shot(page, 'spaces-1-menu.png');
  await menu.getByRole('menuitem', { name: 'New Space…' }).click();

  const made = page.locator('dialog.space-dialog');
  await made.getByRole('heading', { name: 'New Space' }).waitFor();
  await made.getByRole('textbox', { name: 'Name' }).fill('Trips');
  await made.getByRole('textbox', { name: 'Preferences' }).fill('# Trips\n\nPlan trips: dates first, then places. Short answers.');
  await shot(page, 'spaces-2-new.png');
  await made.getByRole('button', { name: /Create Space/ }).click();
  // Shown at once, though nothing has run in it yet.
  await title.filter({ hasText: 'Trips' }).waitFor();
  const dir = join(ah.dir, 'home', 'spaces', 'Trips');
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), '# Trips\n\nPlan trips: dates first, then places. Short answers.');

  // Space settings: preferences and memory, written on the host.
  await title.click();
  await menu.getByRole('menuitem', { name: 'Space settings…' }).click();
  const settings = page.locator('dialog.space-dialog');
  await settings.getByRole('heading', { name: 'Trips' }).waitFor();
  const prefs = settings.getByRole('textbox', { name: 'Preferences' });
  await until(async () => (await prefs.inputValue()).startsWith('# Trips'), 8000, 'preferences loaded');
  await prefs.fill('# Trips\n\nPlan trips: dates first, then places. Short answers. Prices in euros.');
  await settings.getByRole('button', { name: 'Save preferences' }).click();
  await settings.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
  assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /Prices in euros\./);
  await settings.locator('.space-memory summary', { hasText: 'MEMORY.md' }).waitFor();
  await settings.getByRole('textbox', { name: 'New memory file' }).fill('decisions');
  await settings.getByRole('button', { name: 'Add' }).click();
  await settings.locator('.space-memory summary', { hasText: 'decisions.md' }).click();
  await settings.getByRole('textbox', { name: 'decisions.md' }).fill('# Decisions\n\n- Kyoto in October.');
  await settings.locator('.space-memory', { hasText: 'decisions.md' }).getByRole('button', { name: 'Save' }).click();
  await until(() => existsSync(join(dir, 'memory', 'decisions.md')) && readFileSync(join(dir, 'memory', 'decisions.md'), 'utf8').includes('Kyoto'), 8000, 'memory written');
  await shot(page, 'spaces-3-settings.png');

  // Remove: what it does, said first; then off the menu, its folder archived.
  await settings.getByRole('button', { name: 'Remove Space…' }).click();
  const ask = page.locator('dialog.ask');
  await ask.getByText(/folder moves to the Spaces archive/).waitFor();
  await shot(page, 'spaces-4-remove.png');
  await ask.getByRole('button', { name: 'Remove' }).click();
  await title.filter({ hasText: 'Inbox' }).waitFor();
  assert.ok(!existsSync(dir));
  assert.equal((await list()).removed[0]?.name, 'Trips');
  await title.click();
  await menu.getByRole('menuitemradio', { name: 'proj' }).waitFor();
  assert.equal(await menu.getByRole('menuitemradio', { name: 'Trips' }).count(), 0);
  await page.keyboard.press('Escape');

  // Settings → Spaces: Restore.
  await page.goto(`http://localhost:${ah.port}/#settings/spaces`, { waitUntil: 'networkidle' });
  const row = page.locator('.sec-card', { hasText: 'Removed' }).locator('li', { hasText: 'Trips' });
  await row.waitFor();
  await shot(page, 'spaces-5-settings-removed.png');
  await row.getByRole('button', { name: 'Restore' }).click();
  await page.locator('.sec-card', { hasText: 'Removed' }).getByText('Nothing removed.').waitFor();
  assert.ok(existsSync(join(dir, 'memory', 'decisions.md')), 'back with its memory');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: the menu is an action sheet with the Spaces and New Space…', { skip, timeout: 90_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${ah.port}/`, { waitUntil: 'networkidle' });
  await page.locator('button.title-pick').click();
  const sheet = page.getByRole('menu', { name: 'Show sessions from' });
  await sheet.getByRole('menuitemradio', { name: 'Trips' }).waitFor();
  await sheet.getByRole('menuitem', { name: 'New Space…' }).waitFor();
  await shot(page, 'spaces-6-phone-menu.png');
  await sheet.getByRole('menuitemradio', { name: 'Trips' }).click();
  await page.locator('button.title-pick', { hasText: 'Trips' }).waitFor();
  await ctx.close();
});
