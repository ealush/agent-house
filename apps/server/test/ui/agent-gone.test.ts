// Real page → disposable host → a stand-in Codex that exits: Send Now answers 409 agent_gone
// ("Offer Resume", errors.md), and the page offers it; Resume starts the agent again on its
// conversation in its window, and what was queued goes in. No production state.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser } from 'playwright-core';
import { cleanup, http, until } from '../helpers.ts';
import { launch, say, startBed, transcriptOf, windows } from '../fake-agents.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const chrome = [process.env.AH_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome-stable'].find((p) => p && existsSync(p));
const skip = chrome ? false : 'no Chromium';
const shots = process.env.AH_AGENT_GONE_SHOTS;
let ah: Awaited<ReturnType<typeof startBed>>;
let browser: Browser;
let scratch: string;

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(join(tmpdir(), 'ah-gone-'));
  const dist = join(scratch, 'dist');
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });
  ah = await startBed({}, { AH_DIST: dist });
  browser = await chromium.launch({ executablePath: chrome });
  if (shots) mkdirSync(shots, { recursive: true });
});

after(async () => {
  await browser?.close();
  if (ah) await cleanup(ah);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test('Send Now on a session whose agent has exited offers Resume; Resume brings it back and the message goes in', { skip, timeout: 120_000 }, async () => {
  const s = await launch(ah, 'codex', ah.project);
  await say(ah, s.uid, 'hello');
  await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'CRASH' } });
  await until(async () => (await windows(ah)).some((w) => w.uid === s.uid && !w.agent && w.status !== 'busy'), 15_000, 'the agent gone');
  assert.equal((await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'waited for its agent' } })).json().outcome, 'queued');

  const page = await (await browser.newContext({ ...devices['Desktop Chrome'], colorScheme: 'dark' })).newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('ah.view', 'gui'));
  await page.goto(`http://localhost:${ah.port}/#${s.uid}`, { waitUntil: 'domcontentloaded' });
  // Its agent gone, the session shows its terminal; its queue is behind the header's "1 queued".
  await page.getByRole('button', { name: /1 queued/ }).click();
  await page.getByRole('button', { name: 'Send now' }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: "Its agent isn't running" });
  await dialog.waitFor({ timeout: 15_000 });
  if (shots) await page.screenshot({ path: join(shots, 'desktop-agent-gone.png') });
  await dialog.getByRole('button', { name: 'Resume' }).click();

  const back = await until(async () => (await windows(ah)).find((w) => w.uid === s.uid && w.agent === 'codex'), 20_000, 'the agent back');
  assert.equal(back.harnessId, s.harnessId, 'on its conversation');
  assert.equal(back.id, s.id, 'in its own window');
  await until(async () => (await transcriptOf(ah, s.uid))?.includes('Got: waited for its agent'), 20_000, 'what was queued went in');
  assert.deepEqual(errors, []);
});
