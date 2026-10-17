// Browser smoke tests: the real page, against a throwaway ah with its own tmux,
// on a desktop and a phone viewport. They pin what unit tests can't see: that the
// page boots without errors, status reads one way, Back walks history, shells
// don't offer agent-only actions, and a prompt on an agent's screen can be
// answered from the inbox. No real agent runs: a stand-in `claude` draws one.
//
// Needs Chromium or Chrome (AH_CHROMIUM, or a usual path); skipped otherwise.
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
const CHROME = [process.env.AH_CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(
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
  await page.getByText(/No GitHub repository among your sessions' projects/).waitFor();
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
  await page.locator('.tabbar, nav').filter({ hasText: 'Sessions' }).first().waitFor();
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

  await tab('Sessions').tap();
  await landed('Sessions');

  // Inbox → across Sessions → History: the thumb follows, and lifting picks the tab under it.
  await tab('Inbox').tap();
  await landed('Inbox');
  const [inbox, sessions, history] = [await at('Inbox'), await at('Sessions'), await at('History')];
  await slide([inbox, sessions], async () => {
    assert.equal(await bar.locator('button.on').innerText(), 'Sessions');
    assert.equal(await tab('Inbox').getAttribute('aria-current'), 'page');
  });
  await landed('Sessions');
  await slide([sessions, history]);
  await landed('History');

  // Slid well off the bar before lifting: nothing is picked, and the thumb goes home.
  await slide([history, inbox, { x: inbox.x, y: inbox.y - 200 }]);
  await page.waitForTimeout(300);
  assert.equal(await tab('History').getAttribute('aria-current'), 'page');
  assert.match(await bar.locator('button.on').innerText(), /History/);
  assert.deepEqual(errors, []);
  await ctx.close();
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
  await sheet.getByRole('option', { name: /^History/ }).tap();
  await sheet.waitFor({ state: 'detached' });
  await page.locator('h1.page-title', { hasText: 'History' }).waitFor();
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
