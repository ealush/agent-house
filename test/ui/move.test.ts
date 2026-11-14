// Move to another host, in the real page (Workflow B): History's Move asks the other
// host first (where the session would work, what it lacks), moves the stopped session,
// and resumes it there through the hub. Two ah daemons on this machine.
// AH_UI_SHOTS=<dir> saves screenshots of each step.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { cleanup, http, until } from '../helpers.ts';
import { hostPair, launch, say, windows, type Pair } from '../fake-agents.ts';

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

let p: Pair;
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
  const saved = process.env.AH_DIST;
  process.env.AH_DIST = dist;
  try {
    p = await hostPair();
  } finally {
    if (saved === undefined) delete process.env.AH_DIST;
    else process.env.AH_DIST = saved;
  }
  browser = await chromium.launch({ executablePath: CHROME });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  if (skip) return;
  await browser?.close();
  if (p) {
    await cleanup(p.a);
    await cleanup(p.b);
  }
  rmSync(scratch, { recursive: true, force: true });
});

test('desktop: History moves a stopped session to the other host, which resumes it', { skip, timeout: 120_000 }, async () => {
  const { a } = p;
  const s = await launch(a, 'claude', p.aBed.project, 'Ship the parser');
  await say(a, s.uid, 'Rewrite the parser with a state machine');
  await http(a, 'POST', `/api/sessions/${s.uid}/terminate`);
  await until(async () => !(await windows(a)).some((w) => w.uid === s.uid), 8000, 'ended');

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${a.port}/#history`, { waitUntil: 'networkidle' });
  const row = page.locator('.history-row', { hasText: 'Ship the parser' }).first();
  await row.hover();
  await row.getByRole('button', { name: 'Move' }).click();
  const dialog = page.locator('dialog[open]', { hasText: 'Move to another host' });
  await dialog.getByText('a checkout of the same repository').waitFor();
  assert.match(await dialog.innerText(), new RegExp(p.bCheckout.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  await shot(page, 'move-1-preview.png');
  await dialog.getByRole('button', { name: 'Move to mac-b' }).click();
  await dialog.getByText("Moved to mac-b. It's in History there").waitFor({ timeout: 20000 });
  await shot(page, 'move-2-moved.png');
  await dialog.getByRole('button', { name: 'Resume on mac-b' }).click();
  await page.waitForFunction(() => location.hash.startsWith('#mac-b/'), null, { timeout: 15000 });
  await page.locator('.session-pills .pill', { hasText: 'mac-b' }).first().waitFor();
  await shot(page, 'move-3-resumed.png');
  // The original stays on omarchy-a, marked as moved.
  await page.goto(`http://localhost:${a.port}/#history`, { waitUntil: 'networkidle' });
  await page.locator('.history-row', { hasText: 'moved to mac-b' }).first().waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});
