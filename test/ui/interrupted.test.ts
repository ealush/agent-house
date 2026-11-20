// Interrupted sessions in the real page: the bed's tmux server dies under three sessions
// (one mid-turn). The Inbox says so in one card, the ended view says what happened and
// what Restore does, Search's History offers Restore, and Restore all brings them back, the
// mid-turn one told where it stopped. AH_UI_SHOTS=<dir> saves screenshots.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser, type Page } from 'playwright-core';
import { cleanup, http, until } from '../helpers.ts';
import { launch, say, startBed, transcriptFile, windows } from '../fake-agents.ts';

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

test('a crash under three sessions: one card says so; Restore all brings them back', { skip, timeout: 180_000 }, async () => {
  const a = await launch(ah, 'claude', ah.project, 'Fix the login redirect');
  const b = await launch(ah, 'codex', ah.project, 'Write the release notes');
  const c = await launch(ah, 'claude', ah.project, 'Review the stack');
  await say(ah, b.uid, 'draft them');
  await say(ah, c.uid, 'look it over');
  await http(ah, 'POST', `/api/sessions/${a.uid}/send`, { body: { text: 'SLOW 120000' } });
  await until(async () => (await windows(ah)).find((w) => w.uid === a.uid)?.status === 'busy', 8000, 'a working');
  // The crash: the bed's own tmux server (by its socket), every window with it.
  ah.tmux('kill-server');
  await until(async () => (await http(ah, 'GET', '/api/interruptions')).json().count === 3, 10000, 'three interrupted');

  const errors: string[] = [];
  // A phone first: the card is the first thing on the Inbox.
  const phone = await browser.newContext({ ...devices['iPhone 15 Pro'], deviceScaleFactor: 2 });
  const pp = await phone.newPage();
  pp.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // Where the notification's link lands.
  await pp.goto(`http://localhost:${ah.port}/#interrupted`, { waitUntil: 'networkidle' });
  await pp.locator('.card-interrupted').waitFor();
  assert.equal(await pp.locator('.ended-session').count(), 0, 'the Inbox, not a missing session');
  await shot(pp, 'interrupted-phone-inbox.png');
  await phone.close();

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${ah.port}/`, { waitUntil: 'networkidle' });
  const card = page.locator('.card-interrupted');
  await card.waitFor();
  assert.equal(await card.locator('.card-title').innerText(), '3 sessions were interrupted');
  assert.match(await card.locator('.decision-body').innerText(), /^The tmux server stopped at .+; 1 was working\. Restoring resumes each in its own conversation, and tells the ones that were working where they stopped\.$/);
  const rows = card.locator('.interrupted-row');
  assert.equal(await rows.count(), 3);
  assert.match(await rows.nth(0).innerText(), /Fix the login redirect\s+was working/, 'the mid-turn one first');
  assert.match(await rows.nth(2).innerText(), /had finished/);
  assert.match(await page.locator('.section-label.waiting').innerText(), /Needs you\s*1/i);
  assert.equal(await page.locator('.page-head .tagline').innerText(), '3 interrupted.', 'not "All quiet."');
  assert.ok((await card.boundingBox())!.y < (await page.locator('.empty-state').boundingBox())!.y, 'the card before "Nothing running"');
  await shot(page, 'interrupted-desktop-inbox.png');

  // Its ended view says what happened and what Restore does.
  await rows.nth(0).click();
  const pill = page.locator('.session-pills .pill.interrupted');
  await pill.waitFor();
  assert.match(await pill.innerText(), /^Interrupted/);
  assert.match(await page.locator('.interrupted-note').innerText(), /The tmux server stopped at .+, and it was working\. Restore brings it back in the same conversation and tells it where it stopped, before your message\./);
  assert.match(await page.locator('.ended-bar button[type=submit]').innerText(), /^Restore\b/, 'Restore (with its ⌘↵ hint)');
  await shot(page, 'interrupted-desktop-ended.png');

  // Search's History marks them and offers Restore.
  await page.goto(`http://localhost:${ah.port}/#search`, { waitUntil: 'networkidle' });
  const row = page.locator('.history-row', { hasText: 'Fix the login redirect' });
  await row.waitFor();
  // Waited for, not read once: the page fades in (a view transition).
  await row.locator('.sub', { hasText: 'interrupted mid-turn' }).waitFor();
  await row.locator('button.resume', { hasText: /^Restore$/ }).waitFor({ state: 'attached' });
  await row.hover();
  await shot(page, 'interrupted-desktop-history.png');

  // Restore all, from the card.
  await page.goto(`http://localhost:${ah.port}/`, { waitUntil: 'networkidle' });
  await page.locator('.card-interrupted').getByRole('button', { name: 'Restore all' }).click();
  await page.locator('.card-interrupted').waitFor({ state: 'detached', timeout: 20000 });
  const back = await until(async () => {
    const ws = (await windows(ah)).filter((w) => [a.uid, b.uid, c.uid].includes(w.uid) && w.harnessId);
    return ws.length === 3 ? ws : null;
  }, 20000, 'all three running');
  for (const s of [a, b, c]) assert.equal(back.find((w) => w.uid === s.uid)!.harnessId, s.harnessId);
  await until(() => readFileSync(transcriptFile(ah, a.harnessId)!, 'utf8').includes('Got: [ah] This session was interrupted'), 30000, 'told where it stopped');
  await shot(page, 'interrupted-desktop-restored.png');
  assert.deepEqual(errors, []);
  await ctx.close();
});
