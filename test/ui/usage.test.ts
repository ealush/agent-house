// Usage in the real page: tiles that say an estimate is an estimate, a chart of
// tokens per day with a hover readout and a table view, the provider's limit
// windows. Light and dark. AH_UI_SHOTS=<dir> saves screenshots.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { cleanup, http } from '../helpers.ts';
import { launch, say, startBed } from '../fake-agents.ts';

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
  ah = await startBed({ usage: { billing: { anthropic: 'subscription' } } }, { AH_DIST: dist, AH_USAGE: '0' });
  browser = await chromium.launch({ executablePath: CHROME });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  if (skip) return;
  await browser?.close();
  if (ah) await cleanup(ah);
  rmSync(scratch, { recursive: true, force: true });
});

test('desktop: Usage shows estimates as estimates, a chart with a readout and a table, and limit windows', { skip, timeout: 120_000 }, async () => {
  const c = await launch(ah, 'claude', ah.project, 'Metered');
  await say(ah, c.uid, 'first');
  const x = await launch(ah, 'codex', ah.project, 'Codex');
  await say(ah, x.uid, 'one');
  await http(ah, 'POST', '/api/usage/refresh');
  for (const theme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: theme });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.addInitScript((t) => localStorage.setItem('ah.theme', t), theme);
    await page.goto(`http://localhost:${ah.port}/#usage`, { waitUntil: 'networkidle' });
    const tile = page.locator('.stat-tile', { hasText: 'Estimated API cost' });
    await tile.waitFor();
    assert.match(await tile.innerText(), /estimate/i);
    assert.match(await tile.innerText(), /plan bills differently/);
    await page.locator('.usage-chart .mark').first().hover();
    assert.match(await page.locator('.usage-tip').innerText(), /tokens · in/);
    assert.match(await page.locator('.usage-limits').first().innerText(), /reported by the provider/);
    await shot(page, `usage-${theme}.png`);
    if (theme === 'light') {
      await page.getByRole('button', { name: 'Show table' }).click();
      assert.ok((await page.locator('.usage-table').count()) >= 2);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});
