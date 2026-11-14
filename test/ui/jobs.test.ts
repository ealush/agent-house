// Jobs in the real page: a scheduled workflow's decision shows in the Inbox and on the
// Jobs page; Go ahead runs its follow-up; a job made from the page starts an agent.
// AH_UI_SHOTS=<dir> saves screenshots.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { cleanup, http, until } from '../helpers.ts';
import { launch, say, startBed, transcriptOf, windows } from '../fake-agents.ts';

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

test('desktop: a workflow decision in the Inbox, Go ahead sends the follow-up; Jobs makes a job', { skip, timeout: 120_000 }, async () => {
  const impl = await launch(ah, 'claude', ah.project, 'Implement');
  await say(ah, impl.uid, 'Implement the parser');
  const job = (await http(ah, 'POST', '/api/jobs', { body: { name: 'Review findings', action: { kind: 'decide', title: 'Send the review to the implementer?', body: 'The reviewer found: the parser drops trailing commas.', then: { kind: 'send', target: impl.uid, text: 'A reviewer found: the parser drops trailing commas. Fix it.' } }, trigger: { kind: 'manual' } } })).json();
  await http(ah, 'POST', `/api/jobs/${job.id}/run`);
  await until(async () => (await http(ah, 'GET', '/api/state')).json().jobs?.waiting?.length === 1, 10000, 'decision waiting');

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${ah.port}/`, { waitUntil: 'networkidle' });
  const card = page.locator('.card-decision', { hasText: 'Send the review to the implementer?' });
  await card.waitFor();
  assert.match(await card.innerText(), /drops trailing commas/);
  assert.equal(await page.locator('.nav-item', { hasText: 'Jobs' }).locator('.badge').innerText(), '1');
  await shot(page, 'jobs-1-inbox-decision.png');
  await card.getByRole('button', { name: 'Go ahead' }).click();
  await until(async () => (await transcriptOf(ah, impl.uid))?.includes('Fix it.'), 15000, 'follow-up at the implementer');
  await card.waitFor({ state: 'detached' });

  await page.keyboard.press('Control+Shift+6');
  await page.locator('h1.page-title', { hasText: 'Jobs' }).waitFor();
  await page.getByRole('button', { name: 'New job' }).click();
  await page.getByLabel('What to ask').fill('Run the tests and report');
  await page.getByLabel('Name').fill('Nightly tests');
  await page.getByLabel('Folder').fill(ah.project);
  await shot(page, 'jobs-2-new.png');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.locator('.job-row', { hasText: 'Nightly tests' }).waitFor();
  await until(async () => (await windows(ah)).filter((w) => w.agent === 'claude').length === 2, 15000, 'the job started an agent');
  await page.locator('.job-row', { hasText: 'Review findings' }).getByRole('button', { name: /Review findings/ }).click();
  await page.locator('.job-runs li', { hasText: 'done' }).first().waitFor();
  await shot(page, 'jobs-3-page.png');
  assert.deepEqual(errors, []);
  await ctx.close();
});
