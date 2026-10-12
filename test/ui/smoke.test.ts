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
  for (const agentOnly of ['Fork session…', 'Snapshots', 'Queued messages']) assert.equal(await menu.getByText(agentOnly).count(), 0, agentOnly);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /back/i }).first().tap();
  await page.locator('h1.page-title', { hasText: 'Inbox' }).waitFor();
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
