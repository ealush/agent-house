// Spaces in the real page (web/Inbox.tsx's menu, web/SpaceDialogs.tsx, web/SpacePortal.tsx,
// web/SpacesSettings.tsx) against a real host (docs/spec/17-spaces.md, spaces 3): the menu lists
// only made Spaces (a repository is a project) and Not in a Space; New Space attaches a project,
// whose session joins it; its portal starts a Chief of Staff in the Space's own folder; its
// projects, preferences and memory in Space settings; Move to Space; Remove, said before it's
// done; Settings → Spaces puts it back. A phone's menu is an action sheet with the same entries,
// and the portal's header fits it. AH_UI_SHOTS=<dir> saves screenshots.
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

const windowsNow = async () => (await http(ah, 'GET', '/api/state')).json().windows as Array<{ uid: string; title: string; space?: string; cwd: string; supervision?: { role?: string; space?: string } }>;

test('desktop: only made Spaces in the menu; New Space with a project; its portal starts a Chief in its folder; Move to Space; Remove and Restore', { skip, timeout: 180_000 }, async () => {
  // A session in a repository: a project, never a Space, so it's in none.
  const notes = await launch(ah, 'claude', ah.project, 'Release notes');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${ah.port}/`, { waitUntil: 'networkidle' });

  const title = page.locator('button.title-pick');
  await title.click();
  const menu = page.getByRole('menu', { name: 'Show sessions from' });
  await menu.getByRole('menuitemradio', { name: 'All sessions' }).waitFor();
  await menu.getByRole('menuitemradio', { name: 'Not in a Space' }).waitFor();
  assert.equal(await menu.getByRole('menuitemradio', { name: 'proj' }).count(), 0, 'a repository is no Space');
  await shot(page, 'spaces-1-menu.png');
  await menu.getByRole('menuitem', { name: 'New Space…' }).click();

  const made = page.locator('dialog.space-dialog');
  await made.getByRole('heading', { name: 'New Space' }).waitFor();
  await made.getByRole('textbox', { name: 'Name' }).fill('Release');
  await made.getByRole('combobox', { name: 'Attach a project' }).selectOption({ label: `proj — ${ah.project.replace(join(ah.dir, 'home'), '~')}` });
  await made.locator('.space-project-list li', { hasText: 'proj' }).waitFor();
  await made.getByRole('textbox', { name: 'Preferences' }).fill('# Release\n\nShip it weekly. Short answers.');
  await shot(page, 'spaces-2-new.png');
  await made.getByRole('button', { name: /Create Space/ }).click();
  // Shown at once, with the repository's session in it.
  await title.filter({ hasText: 'Release' }).waitFor();
  const dir = join(ah.dir, 'home', 'spaces', 'Release');
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), '# Release\n\nShip it weekly. Short answers.');
  await until(async () => (await windowsNow()).find((w) => w.uid === notes.uid)?.space === 'Release', 8000, "the project's session is in the Space");
  await page.locator('.space-portal-bar .space-project-chip', { hasText: 'proj' }).waitFor();

  // The portal says what a Chief of Staff is and starts one in the Space's own folder.
  const empty = page.locator('.space-chief-empty');
  await empty.getByText('No Chief of Staff in Release yet').waitFor();
  await shot(page, 'spaces-3-portal.png');
  await empty.getByRole('button', { name: 'Start Chief of Staff' }).click();
  const start = page.locator('dialog.space-dialog', { has: page.getByRole('heading', { name: 'Start Chief of Staff' }) });
  await start.waitFor();
  assert.equal(await start.getByRole('checkbox', { name: /Supervise 1 existing/ }).isChecked(), true, 'takes over the session already there');
  await shot(page, 'spaces-4-start-chief.png');
  await start.getByRole('button', { name: 'Start Chief of Staff' }).click();
  await until(async () => (await windowsNow()).some((w) => w.supervision?.role === 'chief' && w.space === 'Release'), 15000, 'a Chief in the Space');
  const chief = (await windowsNow()).find((w) => w.supervision?.role === 'chief')!;
  assert.equal(chief.cwd, '~/spaces/Release', "in the Space's own folder");
  assert.equal(chief.supervision?.space, 'Release');
  await page.goto(`http://localhost:${ah.port}/`, { waitUntil: 'networkidle' });
  await page.locator('.space-chief-grid').waitFor();
  await shot(page, 'spaces-5-portal-chief.png');

  // Space settings: its projects, preferences and memory, written on the host.
  await title.click();
  await menu.getByRole('menuitemradio', { name: /Release/ }).locator('.menu-item-detail', { hasText: 'proj' }).waitFor();
  await menu.getByRole('menuitem', { name: 'Space settings…' }).click();
  const settings = page.locator('dialog.space-dialog');
  await settings.getByRole('heading', { name: 'Release' }).waitFor();
  await settings.locator('.space-project-list li', { hasText: 'proj' }).waitFor();
  const prefs = settings.getByRole('textbox', { name: 'Preferences' });
  await until(async () => (await prefs.inputValue()).startsWith('# Release'), 8000, 'preferences loaded');
  await prefs.fill('# Release\n\nShip it weekly. Short answers. Changelog first.');
  await settings.getByRole('button', { name: 'Save preferences' }).click();
  await settings.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
  assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /Changelog first\./);
  await settings.getByRole('textbox', { name: 'New memory file' }).fill('decisions');
  await settings.getByRole('button', { name: 'Add' }).click();
  await settings.locator('.space-memory summary', { hasText: 'decisions.md' }).click();
  await settings.getByRole('textbox', { name: 'decisions.md' }).fill('# Decisions\n\n- Tuesdays.');
  await settings.locator('.space-memory', { hasText: 'decisions.md' }).getByRole('button', { name: 'Save' }).click();
  await until(() => existsSync(join(dir, 'memory', 'decisions.md')) && readFileSync(join(dir, 'memory', 'decisions.md'), 'utf8').includes('Tuesdays'), 8000, 'memory written');
  await shot(page, 'spaces-6-settings.png');
  await page.keyboard.press('Escape');

  // Move to Space…: out of every Space, though its project is attached.
  await page.goto(`http://localhost:${ah.port}/#${notes.uid}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'More' }).first().click();
  await page.getByRole('button', { name: /Move to Space/ }).click();
  const move = page.locator('dialog.space-dialog', { has: page.getByRole('heading', { name: 'Move to Space' }) });
  await move.getByRole('menuitemradio', { name: /^Release/ }).waitFor();
  await shot(page, 'spaces-7-move.png');
  await move.getByRole('menuitemradio', { name: /No Space/ }).click();
  await until(async () => !(await windowsNow()).find((w) => w.uid === notes.uid)?.space, 8000, 'in no Space');

  // Remove: refused while its Chief works in its folder; then, said first, off the menu, archived.
  await http(ah, 'POST', `/api/sessions/${chief.uid}/terminate`);
  await until(async () => !(await windowsNow()).some((w) => w.uid === chief.uid), 15000, 'the Chief ended');
  await page.goto(`http://localhost:${ah.port}/`, { waitUntil: 'networkidle' });
  await title.click();
  await menu.getByRole('menuitem', { name: 'Space settings…' }).click();
  await settings.getByRole('button', { name: 'Remove Space…' }).click();
  const ask = page.locator('dialog.ask');
  await ask.getByText(/Its projects aren't touched/).waitFor();
  await shot(page, 'spaces-8-remove.png');
  await ask.getByRole('button', { name: 'Remove' }).click();
  await title.filter({ hasText: 'Inbox' }).waitFor();
  assert.ok(!existsSync(dir));
  assert.equal((await list()).removed[0]?.name, 'Release');
  await title.click();
  assert.equal(await menu.getByRole('menuitemradio', { name: /Release/ }).count(), 0);
  await page.keyboard.press('Escape');

  // Settings → Spaces: Restore.
  await page.goto(`http://localhost:${ah.port}/#settings/spaces`, { waitUntil: 'networkidle' });
  const row = page.locator('.sec-card', { hasText: 'Removed' }).locator('li', { hasText: 'Release' });
  await row.waitFor();
  await row.getByRole('button', { name: 'Restore' }).click();
  await page.locator('.sec-card', { hasText: 'Removed' }).getByText('Nothing removed.').waitFor();
  assert.ok(existsSync(join(dir, 'memory', 'decisions.md')), 'back with its memory');
  assert.deepEqual((await list()).spaces.find((x: any) => x.name === 'Release')?.projects?.length, 1, 'and its project');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: the menu is an action sheet with the Spaces and New Space…; the portal header fits', { skip, timeout: 90_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${ah.port}/`, { waitUntil: 'networkidle' });
  await page.locator('button.title-pick').click();
  const sheet = page.getByRole('menu', { name: 'Show sessions from' });
  await sheet.getByRole('menuitemradio', { name: /Release/ }).waitFor();
  await sheet.getByRole('menuitem', { name: 'New Space…' }).waitFor();
  await shot(page, 'spaces-9-phone-menu.png');
  await sheet.getByRole('menuitemradio', { name: /Release/ }).click();
  await page.locator('button.title-pick', { hasText: 'Release' }).waitFor();
  const bar = page.locator('.space-portal-bar');
  await bar.waitFor();
  const box = await bar.boundingBox();
  assert.ok(box && box.width <= 390, `the portal header fits the phone (${box?.width})`);
  const overflow = await bar.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  assert.equal(overflow, false, 'nothing in the portal header spills out');
  await shot(page, 'spaces-10-phone-portal.png');
  await ctx.close();
});
