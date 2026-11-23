// Browser smoke tests: the real page, against a throwaway ah with its own tmux,
// on a desktop and a phone viewport. They pin what unit tests can't see: that the
// page boots without errors, status reads one way, Back walks history, shells
// don't offer agent-only actions, and a prompt on an agent's screen can be
// answered from the inbox. No real agent runs: a stand-in `claude` draws one.
//
// Prefers Playwright's matching Chromium (playwright-core install chromium), then
// a system browser; AH_CHROMIUM overrides both. Skipped if none is installed.
// AH_UI_DIST serves an existing build (CI's dist/); by default the page is built
// into a temp dir, so the live ah's dist/ is never touched.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { cleanup, startAh, type Ah } from '../helpers.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHROME = [process.env.AH_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(
  (p): p is string => !!p && existsSync(p),
);
const skip = CHROME ? false : 'no Chromium or Chrome (set AH_CHROMIUM)';

let ah: Ah;
let browser: Browser;
let url: string;
let scratch: string;
let builtDist: string | null = null;

// A stand-in agent: named `claude` so ah detects it, drawing Claude's permission
// prompt, and reporting the key it gets.
const FAKE_CLAUDE = `#!/bin/bash
printf ' Bash command\\n\\n   rm -rf build\\n   Remove the build folder\\n\\n Do you want to proceed?\\n ❯ 1. Yes\\n   2. No\\n'
IFS= read -rsn1 key
# Like the real one, the prompt goes away once it is answered.
printf '\\033[2J\\033[Hanswered\\n'
sleep 600
`;

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(join(tmpdir(), 'ah-ui-'));
  let dist = process.env.AH_UI_DIST;
  if (!dist) {
    builtDist = dist = join(scratch, 'dist');
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, stdio: 'inherit' });
  }
  const bin = join(scratch, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  chmodSync(join(bin, 'claude'), 0o755);
  // Review asks gh about the sessions' repos: never the real GitHub from a test.
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "gh: not signed in (stand-in)" >&2\nexit 1\n');
  chmodSync(join(bin, 'gh'), 0o755);
  // More agents than New session has buttons for, wherever the tests run.
  for (const name of ['cursor-agent', 'crush', 'pi']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexec sleep 600\n');
    chmodSync(join(bin, name), 0o755);
  }
  const saved = { dist: process.env.AH_DIST, path: process.env.PATH };
  process.env.AH_DIST = dist;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  try {
    ah = await startAh({ auth: { mode: 'off' } });
  } finally {
    process.env.AH_DIST = saved.dist;
    process.env.PATH = saved.path;
    if (saved.dist === undefined) delete process.env.AH_DIST;
  }
  ah.tmux('new-session', '-d', '-s', 'it', '-n', 'zz-idle');
  // Single-quoted for tmux's sh, and a counter: a screen whose text stops changing
  // (one line printed over and over) rightly reads as idle.
  ah.tmux('new-window', '-t', 'it', '-n', 'zz-busy', "bash -c 'i=0; while true; do i=$((i+1)); echo tick $i; sleep 0.5; done'");
  url = `http://localhost:${ah.port}/`;
  browser = await chromium.launch({ executablePath: CHROME });
});

after(async () => {
  await browser?.close();
  if (ah) await cleanup(ah);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** A page that records every script error and console error, to be asserted empty. */
async function open(ctx: BrowserContext, hash = ''): Promise<{ page: Page; errors: string[] }> {
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto(url + hash, { waitUntil: 'networkidle' });
  return { page, errors };
}

test('desktop: the inbox boots clean and reads status one way', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx);
  const busy = page.locator('.rows .row', { hasText: 'zz-busy' });
  await busy.waitFor();
  await page.locator('.section-label', { hasText: 'Working' }).waitFor();
  assert.equal((await busy.locator('.pill').innerText()).trim(), 'working');
  assert.match(await page.locator('.tagline').first().innerText(), /working\./);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('desktop: a session opens its terminal, and Back returns to the inbox', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx);
  await page.locator('.side-session', { hasText: 'zz-idle' }).first().click();
  await page.locator('.term .xterm').first().waitFor();
  assert.notEqual(await page.evaluate(() => location.hash), '');
  await page.goBack();
  await page.locator('h1.page-title', { hasText: 'Inbox' }).waitFor();
  await page.goForward();
  await page.locator('.term .xterm').first().waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('desktop: Review opens from the keyboard and says what it needs', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx);
  await page.locator('.rows .row').first().waitFor();
  await page.keyboard.press('Control+Shift+4');
  await page.locator('h1.page-title', { hasText: 'Review' }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#review');
  await page.getByText(/No GitHub repository among your sessions' Spaces/).waitFor();
  // A link to a stack that isn't there says so, with a way back.
  await page.goto(`${url}#review/nope1234/7`);
  await page.getByText('stack not found').waitFor();
  await page.getByRole('button', { name: 'All stacks' }).click();
  await page.locator('h1.page-title', { hasText: 'Review' }).waitFor();
  assert.deepEqual(errors.filter((e) => !/404/.test(e)), []);
  await ctx.close();
});

test('desktop: the palette opens and closes from the keyboard', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx);
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette-tree').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.palette-tree').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('desktop: Settings shows this device, and says sign-in is off', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx, '#settings');
  await page.locator('.sec-card h2', { hasText: 'This device' }).waitFor();
  assert.match(await page.locator('.settings-intro').innerText(), /Sign-in is off/);
  assert.equal(await page.getByRole('button', { name: 'Lock now' }).count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("phone: a shell's menu offers no agent-only actions, and the chevron goes back", { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
  const { page, errors } = await open(ctx);
  await page.locator('.tabbar').filter({ hasText: 'Inbox' }).first().waitFor();
  await page.locator('.rows .row', { hasText: 'zz-idle' }).first().tap();
  await page.getByRole('button', { name: /menu|more/i }).last().tap();
  const menu = page.locator('.menu, [role="menu"]').last();
  await menu.getByText('Rename').waitFor();
  for (const agentOnly of ['Fork session…', 'Snapshots', 'Queue']) assert.equal(await menu.getByText(agentOnly, { exact: true }).count(), 0, agentOnly);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /back/i }).first().tap();
  await page.locator('h1.page-title', { hasText: 'Inbox' }).waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: a finger slides along the tab bar to pick a tab, and off it to pick none', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
  const { page, errors } = await open(ctx);
  const bar = page.locator('.tabbar');
  const tab = (name: string) => bar.getByRole('button', { name });
  await tab('Inbox').waitFor();
  const at = async (name: string) => {
    const b = (await tab(name).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  // Real touches (CDP), so the page sees the pointer events a finger makes.
  const cdp = await ctx.newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', p?: { x: number; y: number }) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] });
  const slide = async (path: { x: number; y: number }[], mid?: () => Promise<void>) => {
    await touch('touchStart', path[0]);
    for (const p of path.slice(1)) await touch('touchMove', p);
    await mid?.();
    await touch('touchEnd');
  };

  // A page and its fade: a touch that lands during the fade reaches the snapshot, not the bar.
  const landed = async (name: string) => {
    await page.locator('h1.page-title', { hasText: name }).waitFor();
    await page.waitForFunction(() => !document.getAnimations().some((a) => String((a.effect as KeyframeEffect | null)?.pseudoElement).startsWith('::view-transition')));
  };

  // Two tabs: the Inbox, whose search field holds History and Search, and Review.
  assert.deepEqual(await bar.locator(':scope > button').allInnerTexts(), ['Inbox', 'Review']);
  await tab('Review').tap();
  await landed('Review');

  // Review → across to Inbox: the thumb follows, and lifting picks the tab under it.
  const [inbox, review] = [await at('Inbox'), await at('Review')];
  await slide([review, inbox], async () => {
    assert.equal(await bar.locator('button.on').innerText(), 'Inbox');
    assert.equal(await tab('Review').getAttribute('aria-current'), 'page');
  });
  await landed('Inbox');
  await slide([inbox, review]);
  await landed('Review');

  // Slid well off the bar before lifting: nothing is picked, and the thumb goes home.
  await slide([review, inbox, { x: inbox.x, y: inbox.y - 200 }]);
  await page.waitForTimeout(300);
  assert.equal(await tab('Review').getAttribute('aria-current'), 'page');
  assert.match(await bar.locator('button.on').innerText(), /Review/);

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: the Inbox groups by project, as the Sessions tab did, and its old link lands there', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
  const { page, errors } = await open(ctx, '#sessions');
  await page.locator('h1.page-title', { hasText: 'Inbox' }).waitFor();
  await page.locator('.rows .row', { hasText: 'zz-idle' }).first().waitFor();
  await page.waitForFunction(() => !document.documentElement.dataset.vt);
  await page.getByRole('tab', { name: 'Space' }).tap();
  // The status sections give way to the sidebar's blocks; the rows are all still there.
  await page.locator('.section-label', { hasText: 'Working' }).waitFor({ state: 'detached' });
  await page.locator('.rows .row', { hasText: 'zz-idle' }).first().waitFor();
  await page.locator('.rows .row', { hasText: 'zz-busy' }).first().waitFor();
  // One host: nothing to group by host.
  assert.deepEqual(await page.getByRole('tab').allInnerTexts(), ['Status', 'Space']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Needs you leads the Inbox in every grouping, and its sessions are not repeated in the blocks', { skip, timeout: 90_000 }, async () => {
  ah.tmux('new-window', '-t', 'it', '-n', 'zz-ask', 'claude');
  try {
    for (const opts of [{ ...devices['iPhone 15 Pro'] }, { viewport: { width: 1440, height: 900 } }]) {
      const ctx = await browser.newContext(opts);
      const { page, errors } = await open(ctx);
      await page.locator('.card-needs', { hasText: 'zz-ask' }).waitFor({ timeout: 30_000 });
      await page.waitForFunction(() => !document.documentElement.dataset.vt);
      const project = page.getByRole('tab', { name: 'Space' });
      if (opts.viewport.width < 760) await project.tap();
      else await project.click();
      await page.locator('.section-label', { hasText: 'Working' }).waitFor({ state: 'detached' });
      // The card stays on top, first; the blocks under it have every other session, not this one.
      assert.match(await page.locator('.section-label').first().innerText(), /needs you/i);
      await page.locator('.card-needs', { hasText: 'zz-ask' }).waitFor();
      await page.locator('.rows .row', { hasText: 'zz-idle' }).first().waitFor();
      assert.equal(await page.locator('.rows .row', { hasText: 'zz-ask' }).count(), 0);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  } finally {
    ah.tmux('kill-window', '-t', 'it:zz-ask');
  }
});

test('phone: an old link to History opens the Inbox searching, which lists every session and filters as you type', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
  const { page, errors } = await open(ctx, '#history');
  await page.locator('h1.page-title', { hasText: 'Inbox' }).waitFor();
  await page.locator('.section-label', { hasText: 'Sessions' }).waitFor();
  const rows = page.locator('.search-lists .rows .row');
  await rows.filter({ hasText: 'zz-idle' }).first().waitFor();
  await rows.filter({ hasText: 'zz-busy' }).first().waitFor();
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'INPUT', 'no keyboard over the list');
  // Searching, the Inbox's own sections and grouping step aside.
  assert.equal(await page.getByRole('tab', { name: 'Space' }).count(), 0);
  const field = page.getByLabel('Search sessions and conversations');
  await field.fill('zz busy');
  await rows.filter({ hasText: 'zz-idle' }).first().waitFor({ state: 'detached' });
  await rows.filter({ hasText: 'zz-busy' }).first().waitFor();
  await field.fill('qqzzx');
  await page.getByText('No matches.').waitFor();
  assert.equal(await page.getByText('Nothing said matches.').count(), 0, 'one "No matches", not one per section');
  await page.getByRole('button', { name: 'Cancel' }).tap();
  await page.locator('.section-label', { hasText: 'Working' }).waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("desktop: the Inbox's title picks one project, and the Inbox and its search show only that project's sessions", { skip, timeout: 60_000 }, async () => {
  const orbit = join(scratch, 'files', 'orbit-api');
  execFileSync('mkdir', ['-p', orbit]);
  execFileSync('git', ['-C', orbit, 'init', '-q', '-b', 'main']);
  ah.tmux('new-window', '-t', 'it', '-n', 'zz-orbit', '-c', orbit);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const { page, errors } = await open(ctx);
    const rows = page.locator('.page .rows .row');
    await rows.filter({ hasText: 'zz-orbit' }).first().waitFor();
    await rows.filter({ hasText: 'zz-idle' }).first().waitFor();
    // The keyboard reaches the menu from the title, and Enter picks.
    const title = page.locator('.title-pick');
    await title.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Show sessions from' });
    await menu.waitFor();
    assert.equal(await menu.getByRole('menuitemradio').first().innerText(), 'All Spaces');
    assert.equal(await menu.getByRole('menuitemradio', { name: 'All Spaces' }).getAttribute('aria-checked'), 'true');
    // It opens on the current choice; the arrows walk down to the project.
    await page.waitForFunction(() => document.activeElement?.textContent === 'All Spaces');
    for (let i = 0; i < 10 && (await page.evaluate(() => document.activeElement?.textContent)) !== 'orbit-api'; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await menu.waitFor({ state: 'detached' });
    await rows.filter({ hasText: 'zz-idle' }).first().waitFor({ state: 'detached' });
    await rows.filter({ hasText: 'zz-orbit' }).first().waitFor();
    // The title is the project now; the tagline is its counts.
    assert.equal((await title.textContent())?.trim(), 'orbit-api.');
    assert.doesNotMatch(await page.locator('.tagline').first().innerText(), /orbit-api/);
    // New session starts in the project's folder.
    await page.getByRole('button', { name: 'New session', exact: true }).first().click();
    const folder = page.getByPlaceholder('~/code/project');
    await folder.waitFor();
    assert.match(await folder.inputValue(), /orbit-api$/);
    await page.keyboard.press('Escape');
    await folder.waitFor({ state: 'detached' });
    // Searching: the lists are the project's too.
    await page.getByLabel('Search sessions and conversations').click();
    const found = page.locator('.search-lists .rows .row');
    await found.filter({ hasText: 'zz-orbit' }).first().waitFor();
    assert.equal(await found.filter({ hasText: 'zz-idle' }).count(), 0);
    await page.getByRole('button', { name: 'Cancel' }).click();
    // It stays chosen on this device, until All Spaces.
    await page.reload({ waitUntil: 'networkidle' });
    await rows.filter({ hasText: 'zz-orbit' }).first().waitFor();
    assert.equal(await rows.filter({ hasText: 'zz-idle' }).count(), 0);
    await title.click();
    await menu.getByRole('menuitemradio', { name: 'All Spaces' }).click();
    await rows.filter({ hasText: 'zz-idle' }).first().waitFor();
    assert.equal((await title.textContent())?.trim(), 'Inbox.');
    await rows.filter({ hasText: 'zz-orbit' }).first().waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally {
    ah.tmux('kill-window', '-t', 'it:zz-orbit');
  }
});

test('phone: the round button by the tab bar opens the palette as a sheet you walk with a finger', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
  const { page, errors } = await open(ctx);
  await page.getByRole('button', { name: 'Commands' }).tap();
  const sheet = page.locator('.palette-tree');
  const title = sheet.locator('.sheet-title');
  await title.filter({ hasText: 'Commands' }).waitFor();
  // No keyboard over the tree until you ask for one.
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'DIALOG');
  await sheet.getByRole('option', { name: /^Go to/ }).tap();
  await title.filter({ hasText: 'Go to' }).waitFor();
  await sheet.getByRole('button', { name: 'Back to Commands' }).tap();
  await title.filter({ hasText: 'Commands' }).waitFor();
  // A command runs once the sheet is down.
  await sheet.getByRole('option', { name: /^Go to/ }).tap();
  await sheet.getByRole('option', { name: /^Search/ }).tap();
  await sheet.waitFor({ state: 'detached' });
  // Search is the Inbox's field: asked for by name, it gets the keyboard.
  await page.locator('h1.page-title', { hasText: 'Inbox' }).waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Search sessions and conversations');
  await page.locator('.section-label', { hasText: 'Sessions' }).waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a prompt on an agent screen is answered from the inbox, without hooks', { skip, timeout: 90_000 }, async () => {
  ah.tmux('new-window', '-t', 'it', '-n', 'zz-agent', 'claude');
  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
  const { page, errors } = await open(ctx);
  const card = page.locator('.card-needs', { hasText: 'zz-agent' });
  await card.waitFor({ timeout: 30_000 });
  await card.getByText('Yes', { exact: true }).tap();
  const deadline = Date.now() + 20_000;
  while (!/answered/.test(ah.tmux('capture-pane', '-p', '-t', 'it:zz-agent'))) {
    assert.ok(Date.now() < deadline, 'the agent never got the answer');
    await new Promise((r) => setTimeout(r, 250));
  }
  await card.waitFor({ state: 'detached', timeout: 20_000 });
  assert.deepEqual(errors, []);
  await ctx.close();
});

const focused = (page: Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null;
  return a ? `${a.tagName.toLowerCase()}.${a.className}` : 'none';
});

test('desktop: the keyboard lands where you are, and comes back after the palette', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx);
  await page.locator('.side-session', { hasText: 'zz-idle' }).first().click();
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette-tree input').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'), null, { timeout: 2000 });
  // Arrows from a page with nothing focused enter its list.
  await page.keyboard.press('Control+Shift+1');
  await page.locator('h1.page-title', { hasText: 'Inbox' }).waitFor();
  await page.waitForTimeout(400);
  await page.keyboard.press('ArrowDown');
  assert.match(await focused(page), /button\.(row|card-title)/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('desktop: New session works from the keyboard alone', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx);
  await page.keyboard.press('Control+Shift+Enter');
  // A fresh device starts on an agent (ah is for agents), with the keyboard on it.
  await page.waitForFunction(() => document.activeElement?.classList.contains('agent-pill') && document.activeElement.classList.contains('on'));
  // Shell or agent comes first: ← picks Shell and → comes back.
  await page.keyboard.press('Shift+Tab');
  await page.waitForFunction(() => document.activeElement?.closest('.seg.kind') && document.activeElement.textContent === 'Agent');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-checked')), 'true', 'the arrows choose as they go');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Shell');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Agent');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.activeElement?.classList.contains('agent-pill'));
  const before = await page.evaluate(() => document.activeElement?.textContent);
  await page.keyboard.press('ArrowRight');
  const after = await page.evaluate(() => ({ text: document.activeElement?.textContent, on: document.activeElement?.classList.contains('on') }));
  assert.notEqual(after.text, before, 'the arrows move across the agents');
  assert.ok(after.on, 'and choose as they go');
  // Like any radio group, Home and End reach the ends, and ← from the first wraps to the last.
  const pills = await page.locator('.agent-pill').allTextContents();
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), pills[0]);
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), pills.at(-1));
  await page.keyboard.press('Tab');
  assert.match(await focused(page), /^input/, 'one Tab stop for the agents, then the project');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('desktop: New session keeps three agents in front and the rest in a menu', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx);
  await page.keyboard.press('Control+Shift+Enter');
  await page.locator('.seg.kind button', { hasText: 'Agent' }).click();
  assert.equal(await page.locator('.agents > button.agent-pill').count(), 3);
  const more = page.locator('.agent-pill.others');
  await more.click();
  const pick = page.locator('.agent-option', { hasText: 'Crush' });
  await pick.click();
  // The menu's button now stands for the agent picked, and Start says so.
  await page.waitForFunction(() => document.querySelector('.agent-pill.others')?.classList.contains('on'));
  assert.match((await more.textContent()) ?? '', /Crush/);
  assert.match((await page.locator('.actions button[type="submit"]').textContent()) ?? '', /Start Crush/);
  // Shell and back: the agent picked comes back with it.
  await page.locator('.seg.kind button', { hasText: 'Shell' }).click();
  assert.equal(await page.locator('.agents').count(), 0);
  await page.locator('.seg.kind button', { hasText: 'Agent' }).click();
  assert.match((await page.locator('.actions button[type="submit"]').textContent()) ?? '', /Start Crush/);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('desktop: a key typed right after Ctrl+Shift+arrow goes to the pane moved to', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx);
  await page.locator('.side-session', { hasText: 'zz-idle' }).first().click();
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
  await page.keyboard.press('Control+Shift+\\');
  await page.locator('.pane-picker-filter').waitFor();
  await page.keyboard.type('zz-busy');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.pane .xterm').length === 2);
  await page.waitForTimeout(600);
  // Where each key lands, in the keystroke itself: a terminal sends it on at once.
  await page.evaluate(() => {
    (window as any).landed = [];
    document.addEventListener('keydown', (e) => e.key.length === 1 && !e.ctrlKey && (window as any).landed.push(document.activeElement?.closest('.pane')?.getAttribute('data-pane')), true);
  });
  for (const dir of ['ArrowLeft', 'ArrowRight', 'ArrowLeft']) {
    await page.keyboard.press(`Control+Shift+${dir}`);
    await page.keyboard.type('x');
    await page.waitForTimeout(300);
  }
  assert.deepEqual(await page.evaluate(() => (window as any).landed), ['first', 'second', 'first']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('desktop: ↓ then a choice key answers a prompt from the inbox, and focus stays put', { skip, timeout: 90_000 }, async () => {
  ah.tmux('new-window', '-t', 'it', '-n', 'zz-agent-keys', 'claude');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx);
  const card = page.locator('.card-needs', { hasText: 'zz-agent-keys' });
  await card.waitFor({ timeout: 30_000 });
  await card.locator('.card-title').focus();
  // The keys drawn on the choices work from the card's title, where ↓ lands.
  await page.keyboard.press('1');
  assert.match(await focused(page), /button\.ask-option/, 'the answer keeps focus, not the page');
  const deadline = Date.now() + 20_000;
  while (!/answered/.test(ah.tmux('capture-pane', '-p', '-t', 'it:zz-agent-keys'))) {
    assert.ok(Date.now() < deadline, 'the agent never got the answer');
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('desktop: New session right after opening a session keeps the keyboard', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx);
  await page.locator('.side-session', { hasText: 'zz-idle' }).first().click();
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
  // While the session is still claiming the keyboard (its first moments), New session
  // must keep it: keys typed there would otherwise go into the hidden terminal.
  await page.keyboard.press('Control+Shift+Enter');
  await page.waitForTimeout(500);
  assert.ok(await page.evaluate(() => !!document.activeElement?.closest('.new-session [role="radiogroup"]')), 'on the choice of shell or agent');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('desktop: the arrows step through a segmented control and pick, as on a Mac', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await open(ctx, '#settings/appearance');
  const group = page.getByRole('radiogroup', { name: 'Appearance' });
  await group.getByRole('radio').first().focus();
  const picked = () => group.evaluate((g) => g.querySelector('[aria-checked="true"]')?.textContent?.trim());
  const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim());
  await page.keyboard.press('ArrowRight');
  assert.equal(await picked(), 'Dark');
  assert.equal(await focused(), 'Dark');
  await page.keyboard.press('End');
  assert.equal(await focused(), await picked());
  await page.keyboard.press('Home');
  assert.equal(await picked(), 'System');
  // A single row: ↓ steps forward, as a radio group's arrows do.
  await page.keyboard.press('ArrowDown');
  assert.equal(await picked(), 'Dark');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: a swipe back lands on the inbox once, even when the browser is slow to go back', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
  const { page, errors } = await open(ctx);
  await page.locator('.rows .row', { hasText: 'zz-idle' }).first().tap();
  await page.locator('main.main .session-head').first().waitFor();
  await page.waitForTimeout(600);
  // iOS answers history.back() late. Every frame from here on is recorded: once the
  // session has gone, it must not come back, and no second transition may play.
  await page.evaluate(() => {
    const back = history.back.bind(history);
    history.back = () => void setTimeout(back, 400);
    const w = window as unknown as { frames_: string[] };
    w.frames_ = [];
    const vt = document.startViewTransition?.bind(document);
    if (vt) document.startViewTransition = ((cb: () => void) => (w.frames_.push('transition'), vt(cb))) as typeof document.startViewTransition;
    const frame = () => {
      const main = document.querySelector<HTMLElement>('main.main');
      const s = !main?.querySelector('.session-head') ? 'page' : main.style.transform ? 'leaving' : 'session';
      if (w.frames_.at(-1) !== s) w.frames_.push(s);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const cdp = await ctx.newCDPSession(page);
  const at = (x: number) => [{ x, y: 400, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(6) });
  for (let x = 20; x <= 260; x += 20) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(x) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => location.hash === '');
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { frames_: string[] }).frames_), ['session', 'leaving', 'page']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("phone: a touch from the screen's edge keeps the browser's own swipe off, and still taps and scrolls", { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
  const { page, errors } = await open(ctx);
  // What a later listener sees: iOS starts its Back/Forward swipe only from a touchstart left alone.
  await page.evaluate(() => {
    const w = window as unknown as { kept_: boolean[] };
    w.kept_ = [];
    addEventListener('touchstart', (e) => w.kept_.push(e.defaultPrevented));
  });
  const kept = () => page.evaluate(() => (window as unknown as { kept_: boolean[] }).kept_.splice(0));
  const cdp = await ctx.newCDPSession(page);
  const touch = async (points: { x: number; y: number }[]) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...points[0], id: 1 }] });
    for (const p of points.slice(1)) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...p, id: 1 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  // A tap at the very edge of a row opens it, as anywhere else on it would.
  const row = (await page.locator('.rows .row', { hasText: 'zz-idle' }).first().boundingBox())!;
  await touch([{ x: 8, y: row.y + row.height / 2 }]);
  await page.locator('main.main .session-head').first().waitFor();
  assert.deepEqual(await kept(), [true]);
  // A touch during the page's fade lands on <html>, not on what's drawn.
  await page.waitForFunction(() => !document.getAnimations().some((a) => String((a.effect as KeyframeEffect | null)?.pseudoElement).startsWith('::view-transition')));

  // The middle of the screen is the browser's, as before.
  await touch([{ x: 200, y: 600 }]);
  assert.deepEqual(await kept(), [false]);

  // A drag up from the edge scrolls what it's on.
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'edge-scroll';
    box.style.cssText = 'position:fixed;inset:120px 0 auto 0;height:300px;overflow-y:auto;z-index:9999;background:#000';
    box.innerHTML = '<div style="height:3000px"></div>';
    document.body.append(box);
  });
  await touch([350, 320, 290, 260, 230, 200].map((y) => ({ x: 6, y })));
  assert.deepEqual(await kept(), [true]);
  assert.ok((await page.evaluate(() => document.getElementById('edge-scroll')!.scrollTop)) >= 140);
  assert.deepEqual(errors, []);
  await ctx.close();
});

/** Every visible control smaller than 32px either way. The message rail's ticks are one
 *  control together (a scrubber, like an iPhone's section index), so they don't count. */
const SMALL = () => {
  const sel = 'button, a[href], [role=button], [role=tab], [role=menuitem], [role=option], [role=radio], [role=switch], input:not([type=hidden]), select, textarea, summary';
  return [...document.querySelectorAll<HTMLElement>(sel)]
    .filter((el) => !el.closest('.xterm, [inert], [aria-hidden=true], .gui-rail'))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      const shown = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && st.visibility !== 'hidden' && st.opacity !== '0' && st.pointerEvents !== 'none';
      return shown && (r.width < 31.5 || r.height < 31.5);
    })
    .map((el) => `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)} ${el.className} "${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30)}"`);
};

test('iPad in portrait: the sidebar slides over the page, by its button, a swipe from the edge, and goes away when you pick', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'] });
  const { page, errors } = await open(ctx);
  const over = page.locator('.side-over');
  // Portrait leaves the page its width: no sidebar beside it, only its button.
  await page.getByRole('button', { name: 'Show sidebar' }).waitFor();
  assert.equal(await page.locator('.sidebar').count(), 0);
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await over.waitFor();
  // Picking a session puts it away and opens the session.
  await over.locator('.side-session', { hasText: 'zz-idle' }).first().click();
  await over.waitFor({ state: 'detached' });
  await page.locator('.term .xterm').first().waitFor();
  // A drag in from the left edge brings it back, a drag to the left puts it away.
  const cdp = await ctx.newCDPSession(page);
  const drag = async (from: number, to: number) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y: 500, id: 1 }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from + ((to - from) * i) / 8, y: 500, id: 1 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await drag(6, 220);
  await over.waitFor();
  await drag(220, 20);
  await over.waitFor({ state: 'detached' });
  // Escape, and the dimmed page, close it too.
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await over.waitFor();
  await page.keyboard.press('Escape');
  await over.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await ctx.close();
  // Landscape keeps it beside the page.
  const wide = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  const { page: lp } = await open(wide);
  await lp.locator('.sidebar').first().waitFor();
  assert.equal(await lp.locator('.side-over').count(), 0);
  await wide.close();
});

test('iPad in portrait: the sidebar follows the finger, and the release settles it by how far and how fast', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'] });
  const { page, errors } = await open(ctx);
  await page.getByRole('button', { name: 'Show sidebar' }).waitFor();
  const over = page.locator('.side-over');
  const cdp = await ctx.newCDPSession(page);
  const touch = (type: string, x?: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: x === undefined ? [] : [{ x, y: 500, id: 1 }] });
  // Slowly to x, held there (no flick), and left down.
  const to = async (from: number, x: number) => {
    await touch('touchStart', from);
    for (let i = 1; i <= 10; i++) {
      await touch('touchMove', from + ((x - from) * i) / 10);
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(150);
  };
  const shift = () => over.evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).m41);
  // In from the edge: its right edge stays under the finger, over a page dimmed as far.
  await to(4, 90);
  const w = await over.evaluate((e) => (e as HTMLElement).offsetWidth);
  assert.ok(Math.abs((await shift()) - (90 - w)) < 2, 'the sidebar edge is under the finger');
  const dim = Number(await page.locator('.side-scrim').evaluate((e) => getComputedStyle(e).opacity));
  assert.ok(Math.abs(dim - 90 / w) < 0.05);
  // Let go a third of the way out, held still: it goes back.
  await touch('touchEnd');
  await over.waitFor({ state: 'detached' });
  // Most of the way out: it opens, and stays put.
  await to(4, w - 40);
  await touch('touchEnd');
  await page.waitForTimeout(400);
  assert.equal(await over.count(), 1);
  assert.equal(await shift(), 0);
  // Pushed back a little and let go: still open. A flick: gone.
  await to(200, 150);
  assert.ok((await shift()) < -40);
  await touch('touchEnd');
  await page.waitForTimeout(400);
  assert.equal(await shift(), 0);
  await touch('touchStart', 200);
  for (const x of [190, 170, 140]) {
    await touch('touchMove', x);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd');
  await over.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('iPad with a hardware keyboard: the first key only it can send brings key hints back and puts the on-screen keys away', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  const { page, errors } = await open(ctx);
  await page.locator('.side-session', { hasText: 'zz-idle' }).first().click();
  await page.locator('.term .xterm').first().waitFor();
  // Touch alone: the terminal has its key bar, and menus name no keys.
  await page.locator('.keybar').waitFor();
  await page.getByRole('button', { name: 'More' }).first().click();
  assert.equal(await page.locator('.menu .keycaps:visible').count(), 0);
  // Escape: there is no Escape on iPadOS's on-screen keyboard.
  await page.keyboard.press('Escape');
  await page.locator('.keybar').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'More' }).first().click();
  assert.ok((await page.locator('.menu .keycaps:visible').count()) > 0, 'menus show their keys');
  // Remembered on this device.
  await page.reload();
  await page.locator('.term .xterm').first().waitFor();
  assert.equal(await page.locator('.keybar').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("desktop: a session row's menu copies the session's link, to paste into another session", { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const { page, errors } = await open(ctx);
  const row = page.locator('.side-row', { hasText: 'zz-idle' }).first();
  await row.waitFor();
  const key = await page.evaluate(async () => ((await (await fetch('/api/state')).json()) as { windows: { title: string; uid: string }[] }).windows.find((w) => w.title.includes('zz-idle'))!.uid);
  await row.click({ button: 'right' });
  await page.locator('.row-menu').getByRole('button', { name: 'Copy Link' }).click();
  await page.getByText('Copied the link').waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `http://localhost:${ah.port}/#${key}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('iPad: a finger held on a session row, or a secondary click, opens its menu, and menus stay on screen', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  const { page, errors } = await open(ctx);
  const row = page.locator('.side-row', { hasText: 'zz-idle' }).first();
  await row.waitFor();
  const before = await page.evaluate(() => location.hash);
  // Held still: the menu, and the lift opens nothing.
  const b = (await row.boundingBox())!;
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + 80, y: b.y + b.height / 2, id: 1 }] });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.locator('.row-menu').waitFor();
  assert.equal(await page.evaluate(() => location.hash), before, 'the hold opened no session');
  await page.keyboard.press('Escape');
  await page.mouse.click(900, 400);
  // A secondary click (two fingers on a trackpad).
  await row.click({ button: 'right' });
  await page.locator('.row-menu').waitFor();
  const inView = async (sel: string) => {
    const r = (await page.locator(sel).first().boundingBox())!;
    return r.y >= 0 && r.y + r.height <= 834 + 1;
  };
  assert.ok(await inView('.row-menu'), 'the row menu is on screen');
  await page.mouse.click(900, 400);
  // A plain tap still opens the session; its menu, long on an iPad, fits under its button.
  await row.tap();
  await page.locator('.term .xterm').first().waitFor();
  await page.getByRole('button', { name: 'More' }).first().click();
  await page.waitForTimeout(300);
  assert.ok(await inView('.menu'), 'the session menu is on screen');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('iPad home-screen app in a window: a strip at the top for the window buttons, none in full screen', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 900, height: 700 }, screen: { width: 834, height: 1194 } });
  // A home-screen app: Playwright can't install one, so it answers as one.
  await ctx.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => (q === '(display-mode: standalone)' ? ({ ...real(q), matches: true, media: q } as MediaQueryList) : real(q));
  });
  const { page, errors } = await open(ctx);
  const button = page.getByRole('button', { name: 'Show sidebar' });
  await button.waitFor();
  const root = page.locator('html');
  assert.equal(await root.getAttribute('data-window-controls'), '');
  // The buttons reach ~30px down the corner: the sidebar button sits below them.
  assert.ok((await button.boundingBox())!.y >= 32);
  // Full screen: the corner is ah's again.
  await page.setViewportSize({ width: 1194, height: 834 });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-window-controls'));
  assert.ok((await page.locator('.sidebar').first().boundingBox())!.y < 32);
  // Settings → Appearance can always leave it.
  await page.evaluate(() => (location.hash = 'settings/appearance'));
  await page.getByRole('radio', { name: 'Always' }).click();
  assert.equal(await root.getAttribute('data-window-controls'), '');
  await page.getByRole('radio', { name: 'In a window' }).click();
  assert.equal(await root.getAttribute('data-window-controls'), null);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("iPad: a finger's tap leaves no hover behind, and the trackpad's pointer still gets it", { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  const { page, errors } = await open(ctx);
  const root = page.locator('html');
  const row = page.locator('.side-row', { hasText: 'zz-idle' }).first();
  await row.waitFor();
  // A row's Terminate shows under the pointer. A finger's tap set :hover and kept it,
  // so the row you had just opened showed it, a tap away from ending the session.
  const kill = () => row.locator('.row-kill').evaluate((e) => getComputedStyle(e).display);
  await row.locator('.side-session').tap();
  await page.locator('.term .xterm').first().waitFor();
  // Safari doesn't focus a button on a tap (Chromium does, which shows the row's actions too).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  assert.equal(await root.getAttribute('data-touch'), '');
  assert.equal(await row.evaluate((e) => e.matches(':hover')), true, 'the browser still counts the tap as a hover');
  assert.equal(await kill(), 'none');
  // The trackpad's pointer: hover shows it again.
  await row.hover();
  assert.equal(await root.getAttribute('data-touch'), null);
  assert.notEqual(await kill(), 'none');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: a finger held on a session row lifts it into its menu, and the lift opens nothing', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
  const { page, errors } = await open(ctx, '#sessions');
  const row = page.locator('.rows .row', { hasText: 'zz-idle' }).first();
  await row.waitFor();
  const cdp = await ctx.newCDPSession(page);
  const hold = async () => {
    const b = (await row.boundingBox())!;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + 100, y: b.y + b.height / 2, id: 1 }] });
    await page.waitForTimeout(650);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const menu = page.locator('.press-menu');
  await hold();
  await menu.waitFor();
  assert.equal(new URL(page.url()).hash, '#sessions', 'the lift opened nothing');
  for (const label of ['Open', 'Rename session', 'Pin', 'Terminate session']) await menu.getByRole('menuitem', { name: label }).waitFor();
  // A tap on the page puts it back; Escape too.
  await page.touchscreen.tap(200, 60);
  await menu.waitFor({ state: 'detached' });
  await hold();
  await menu.waitFor();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  // Open opens the session.
  await hold();
  await menu.getByRole('menuitem', { name: 'Open' }).tap();
  await page.locator('.term .xterm').first().waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: a session row swipes left to Pin and Terminate, and a full swipe asks to terminate', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
  const { page, errors } = await open(ctx, '#sessions');
  const row = page.locator('.rows .row', { hasText: 'zz-idle' }).first();
  await row.waitFor();
  const cdp = await ctx.newCDPSession(page);
  const swipe = async (dist: number) => {
    const b = (await row.boundingBox())!;
    const y = b.y + b.height / 2;
    const x0 = b.x + b.width - 30;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y, id: 1 }] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 - (dist * i) / 12, y, id: 1 }] });
      await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(400);
  };
  const swiped = page.locator('.swipe.open');
  // Past half the actions: it stays open on Pin and Terminate, and opened nothing.
  await swipe(140);
  await swiped.waitFor();
  assert.equal(new URL(page.url()).hash, '#sessions');
  await swiped.getByRole('button', { name: 'Pin' }).waitFor();
  await swiped.getByRole('button', { name: 'Terminate' }).waitFor();
  // A tap on the open row only closes it.
  await row.tap();
  await swiped.waitFor({ state: 'detached' });
  assert.equal(new URL(page.url()).hash, '#sessions');
  // A full swipe asks to terminate; Cancel leaves the session.
  await swipe(300);
  const dialog = page.getByRole('dialog').filter({ hasText: 'Terminate' });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await row.waitFor();
  // A short drag goes back, and a tap still opens the session.
  await swipe(30);
  assert.equal(await swiped.count(), 0);
  await row.tap();
  await page.locator('.term .xterm').first().waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("phone: Settings is iOS Settings' list, a section is a page with Back, and on/off settings are switches", { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
  const { page, errors } = await open(ctx, '#settings');
  const sheet = page.locator('dialog.settings-sheet');
  await sheet.locator('.ios-group-name', { hasText: 'This device' }).waitFor();
  await sheet.locator('.ios-group-name', { hasText: 'This host' }).waitFor();
  assert.equal(await sheet.locator('.settings-nav').count(), 0, 'no row of section tabs');
  await sheet.locator('.ios-row', { hasText: 'Notifications' }).click();
  await page.waitForFunction(() => location.hash === '#settings/notifications');
  assert.equal(await sheet.locator('.sheet-title').innerText(), 'Notifications');
  // On/off settings are switches: the switch at the row's end.
  const sw = sheet.locator('input[type="checkbox"][switch]').first();
  await sw.waitFor();
  const label = sw.locator('xpath=..');
  const [l, b] = [(await label.boundingBox())!, (await sw.boundingBox())!];
  assert.ok(l.x + l.width - (b.x + b.width) < 2, 'the switch ends the row');
  // Back goes to the list.
  await sheet.getByRole('button', { name: 'Back to Settings' }).click();
  await page.waitForFunction(() => location.hash === '#settings');
  await sheet.locator('.ios-list').first().waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
  // A desktop's #settings is still Security beside the section list.
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page: dp } = await open(desk, '#settings');
  await dp.locator('.settings-nav .nav-item.on', { hasText: 'Security' }).waitFor();
  assert.equal(await dp.locator('.ios-list').count(), 0);
  await desk.close();
});

test('phone: a held row and a full swipe tick a haptic (vibrate, or iOS Safari\'s switch)', { skip, timeout: 60_000 }, async () => {
  for (const ios of [false, true]) {
    const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
    await ctx.addInitScript((ios: boolean) => {
      const w = window as unknown as { ticks: number };
      w.ticks = 0;
      // iOS Safari has no vibrate(): ah flips a hidden switch instead.
      if (ios) Object.defineProperty(Navigator.prototype, 'vibrate', { value: undefined, configurable: true });
      else Object.defineProperty(Navigator.prototype, 'vibrate', { value: () => (w.ticks++, true), configurable: true });
    }, ios);
    const { page, errors } = await open(ctx, '#sessions');
    const row = page.locator('.rows .row', { hasText: 'zz-idle' }).first();
    await row.waitFor();
    const ticks = () => page.evaluate(() => (window as unknown as { ticks: number }).ticks);
    const flips = () => page.evaluate(() => [...document.querySelectorAll('body > label[aria-hidden] input[switch]')].length);
    if (ios) await page.evaluate(() => document.addEventListener('click', (e) => (e.target as Element).closest('body > label[aria-hidden]') && ((window as unknown as { ticks: number }).ticks += 1000), true));
    const cdp = await ctx.newCDPSession(page);
    const b = (await row.boundingBox())!;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + 100, y: b.y + b.height / 2, id: 1 }] });
    await page.waitForTimeout(650);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.locator('.press-menu').waitFor();
    if (ios) assert.equal(await flips(), 1, 'the hidden switch is there');
    // The tick reached nobody: the menu is still open.
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.press-menu').count(), 1);
    assert.ok((await ticks()) >= (ios ? 1000 : 1), 'a tick for the menu');
    await page.keyboard.press('Escape');
    await page.locator('.press-menu').waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test('no control is smaller than 32px, on a desktop or a phone', { skip, timeout: 90_000 }, async () => {
  for (const opts of [{ viewport: { width: 1440, height: 900 } }, { ...devices['iPhone 15 Pro'] }, { ...devices['iPad Pro 11'] }]) {
    const ctx = await browser.newContext(opts);
    const { page, errors } = await open(ctx);
    const found: string[] = [];
    const look = async (where: string) => found.push(...(await page.evaluate(SMALL)).map((s) => `${where}: ${s}`));
    await page.locator('.rows .row').first().waitFor();
    await look('inbox');
    await page.locator('.rows .row', { hasText: 'zz-idle' }).first().click();
    await page.locator('main.main .session-head').first().waitFor();
    await look('session');
    await page.getByRole('button', { name: /menu|more/i }).last().click();
    await page.locator('.menu, [role="menu"]').last().getByText('Rename').waitFor();
    await look('session menu');
    await page.keyboard.press('Escape');
    await page.goto(`${url}#review`);
    await page.locator('h1.page-title', { hasText: 'Review' }).waitFor();
    await look('review');
    assert.deepEqual(found, [], `${opts.viewport?.width}px wide`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test('phone: a finger slides along a segmented control to pick, and a tap still taps', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
  const { page, errors } = await open(ctx);
  await page.locator('.rows .row', { hasText: 'zz-idle' }).first().tap();
  const strip = page.locator('.seg-tabs');
  await strip.waitFor();
  // A touch during the page's fade lands on the transition, not the page: let it finish.
  await page.waitForFunction(() => !document.documentElement.dataset.vt);
  await page.waitForTimeout(300);
  const at = async (name: string) => {
    const b = (await strip.getByRole('tab', { name }).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const cdp = await ctx.newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', p?: { x: number; y: number }) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [p] : [] });
  const from = await at((await strip.locator('[aria-selected=true]').textContent())!.trim());
  const to = await at('Chat');
  await touch('touchStart', from);
  for (let i = 1; i <= 8; i++) await touch('touchMove', { x: from.x + ((to.x - from.x) * i) / 8, y: from.y });
  // Mid-slide the thumb is under the finger; nothing is picked until it lifts.
  assert.equal(await strip.locator('[data-held]').textContent(), 'Chat');
  await touch('touchEnd');
  await page.waitForFunction(() => document.querySelector('.seg-tabs [aria-selected=true]')?.textContent === 'Chat');
  await page.waitForTimeout(150);
  await strip.getByRole('tab', { name: 'Files' }).tap();
  await page.waitForFunction(() => document.querySelector('.seg-tabs [aria-selected=true]')?.textContent === 'Files');
  assert.deepEqual(errors, []);
  await ctx.close();
});
