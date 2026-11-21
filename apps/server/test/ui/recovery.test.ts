// Recovery in the real page: a rate-limited session says it's limited and until when;
// switching on "Keep going after limits and crashes" from its menu schedules it to go
// on at the reset. AH_UI_SHOTS=<dir> saves screenshots.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { cleanup, http, until } from '../helpers.ts';
import { launch, startBed, windows } from '../fake-agents.ts';

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
  ah = await startBed({ recovery: { auto: false, jitterSeconds: 0 } }, { AH_DIST: dist });
  browser = await chromium.launch({ executablePath: CHROME });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  if (skip) return;
  await browser?.close();
  if (ah) await cleanup(ah);
  rmSync(scratch, { recursive: true, force: true });
});

test('desktop: a limited session says until when; switching recovery on schedules it', { skip, timeout: 120_000 }, async () => {
  const s = await launch(ah, 'claude', ah.project, 'Long task');
  await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'RATELIMIT 900' } });
  await until(async () => (await windows(ah)).find((w) => w.uid === s.uid)?.recovery?.state === 'waiting_capacity', 15000, 'limited');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${ah.port}/#${s.uid}`, { waitUntil: 'networkidle' });
  const pill = page.locator('.session-pills .pill', { hasText: '↻' });
  await pill.waitFor();
  assert.match(await pill.innerText(), /limited until/);
  await shot(page, 'recovery-1-limited.png');
  await page.getByRole('button', { name: 'More' }).first().click();
  await page.getByRole('menuitemcheckbox', { name: /Keep going after limits/ }).click();
  await page.locator('.session-pills .pill', { hasText: 'going on at' }).waitFor();
  await shot(page, 'recovery-2-scheduled.png');
  assert.equal((await http(ah, 'GET', `/api/sessions/${s.uid}/recovery`)).json().auto, true);
  assert.deepEqual(errors, []);
  await ctx.close();
});
