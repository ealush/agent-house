// Continue in, in the real page: the session menu's Continue in Codex shows what
// carries over before anything starts, then opens the Codex session, which says
// where it came from. Stand-in agents (test/fixtures/fake-harness.js).
// AH_UI_SHOTS=<dir> saves screenshots of each step.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { cleanup, until } from '../helpers.ts';
import { launch, say, startBed, windows } from '../fake-agents.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHROME = [process.env.AH_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p): p is string => !!p && existsSync(p));
const skip = CHROME ? false : 'no Chromium or Chrome (set AH_CHROMIUM)';
const SHOTS = process.env.AH_UI_SHOTS;
/** A screenshot once transitions have finished (the page fades between sessions). */
async function shot(page: import('playwright-core').Page, name: string) {
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

test('desktop: Continue in Codex previews what carries over, then opens a Codex session that says where it came from', { skip, timeout: 120_000 }, async () => {
  const claude = await launch(ah, 'claude', ah.project, 'Login fix');
  await say(ah, claude.uid, 'Fix the flaky login test in auth.spec.ts');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${ah.port}/#${claude.uid}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'More' }).first().click();
  await page.getByRole('button', { name: 'Continue in Codex' }).click();
  const dialog = page.locator('dialog[open]', { hasText: 'Continue in Codex' });
  await dialog.getByText('does not transfer').first().waitFor({ timeout: 8000 }).catch(async (err) => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'continue-0-failed.png') });
    throw new Error(`${err.message}\n${await page.locator('dialog[open]').innerText().catch(() => '(no dialog)')}`);
  });
  assert.match(await dialog.innerText(), /reconstructed from Claude Code's transcript/);
  await shot(page, 'continue-1-preview.png');
  await dialog.getByText("What doesn't carry over").click();
  await dialog.locator('.continue-limits li').first().waitFor();
  await shot(page, 'continue-2-limits.png');
  await dialog.getByRole('button', { name: 'Continue in Codex' }).click();
  const codex = await until(async () => (await windows(ah)).find((w) => w.agent === 'codex'), 15000, 'codex session');
  await page.waitForFunction((uid) => location.hash.endsWith(uid), codex.uid);
  const pill = page.locator('.session-pills button.pill', { hasText: 'Claude Code' });
  await pill.waitFor();
  assert.match((await pill.getAttribute('title')) ?? '', /Continued from “Login fix” in Claude Code/);
  await page.locator('.session-head, header').filter({ hasText: 'Codex' }).first().waitFor().catch(() => {});
  await shot(page, 'continue-3-codex.png');
  await pill.click();
  await page.waitForFunction((uid) => location.hash.endsWith(uid), claude.uid);
  assert.deepEqual(errors, []);
  await ctx.close();
});
