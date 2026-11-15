// Run in Terminal: a real page → a code block's Run → a disposable host's shell runs it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser, type BrowserContextOptions } from 'playwright-core';
import { startAh, cleanup, http, until, type Ah } from '../helpers.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const chrome = [process.env.AH_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome-stable'].find((p) => p && existsSync(p));
const skip = chrome ? false : 'no Chromium';
const shots = process.env.AH_RUN_SHOTS;
let ah: Ah;
let browser: Browser;
let scratch: string;
let uid: string;

const windows = async () => (await http(ah, 'GET', '/api/state')).json().windows as Array<{ uid: string; agent: string | null; cwd: string; command: string }>;
const capture = async (id: string) => (await http(ah, 'GET', `/api/sessions/${id}/capture`)).body;
/** Shells in the agent's folder (the host's own first window is elsewhere). */
const shellsHere = async () => {
  const all = await windows();
  const cwd = all.find((w) => w.uid === uid)!.cwd;
  return all.filter((w) => !w.agent && w.cwd === cwd);
};

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(join(tmpdir(), 'ah-run-'));
  const fixture = fileURLToPath(new URL('../fixtures/transcript-agent.js', import.meta.url));
  const dist = join(scratch, 'dist');
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });
  const saved = process.env.AH_DIST;
  process.env.AH_DIST = dist;
  try {
    ah = await startAh({ auth: { mode: 'off' }, idleAfter: 1, presets: [{ id: 'claude', name: 'Run test', command: `exec ${process.execPath} ${fixture}`, match: '^node$', feed: 'claude' }, { id: 'shell', name: 'Shell', command: '' }] });
  } finally {
    if (saved === undefined) delete process.env.AH_DIST;
    else process.env.AH_DIST = saved;
  }
  const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'claude', cwd: `${ah.dir}/files`, label: 'Run test' } });
  assert.equal(created.status, 201, created.body);
  uid = created.json().uid;
  await until(async () => (await windows()).find((w) => w.uid === uid && ['idle', 'attention'].includes((w as { status?: string }).status ?? '')), 20_000, 'ready transcript fixture');
  const sent = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'snippets' } });
  assert.equal(sent.status, 200, sent.body);
  browser = await chromium.launch({ executablePath: chrome });
  if (shots) mkdirSync(shots, { recursive: true });
});

after(async () => {
  await browser?.close();
  if (ah) await cleanup(ah);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function open(options: BrowserContextOptions) {
  for (const previous of browser.contexts()) await previous.close();
  const ctx = await browser.newContext(options);
  const errors: string[] = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('ah.view', 'gui'));
  await page.goto(`http://localhost:${ah.port}/#${uid}`, { waitUntil: 'domcontentloaded' });
  await page.getByText('snippets-ran').first().waitFor({ timeout: 20_000 });
  return { ctx, page, errors };
}

test('desktop: a shell block runs in a shell in the session’s folder, beside it; a second run reuses that shell', { skip, timeout: 90_000 }, async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1440, height: 900 } });
  const sh = page.locator('.code-snippet', { has: page.locator('code.language-sh') });
  const ts = page.locator('.code-snippet', { has: page.locator('code.language-ts') });
  assert.equal(await ts.locator('.code-run').count(), 0, 'TypeScript is not run');
  await sh.hover();
  const run = sh.getByRole('button', { name: 'Run in Terminal' });
  await run.click();
  // The first press only says where.
  const armed = sh.getByRole('button', { name: /^Run in a shell in / });
  await armed.waitFor();
  if (shots) await page.screenshot({ path: join(shots, 'armed.png') });
  assert.equal((await shellsHere()).length, 0, 'nothing ran on the first press');
  await armed.click();
  const shell = await until(async () => (await shellsHere())[0], 15_000, 'a shell in the session’s folder');
  await until(async () => (await capture(shell.uid)).includes('\nsnippets-ran'), 15_000, 'the snippet’s output');
  // Shown beside the conversation: two panes, the conversation still there.
  await until(async () => (await page.locator('.pane').count()) === 2, 10_000, 'the shell beside the conversation');
  assert.equal(await page.getByText('snippets-ran').count() > 0, true);
  if (shots) {
    // Once the split (or the page's fade) has settled and the shell has drawn.
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(shots, 'beside.png') });
  }

  // Again: the same shell, waiting at its prompt, takes it; no second one starts, nor a third pane.
  await until(async () => /\$ ?$/.test((await capture(shell.uid)).trimEnd()), 10_000, 'the shell back at its prompt');
  await sh.hover();
  await sh.getByRole('button', { name: 'Run in Terminal' }).click();
  await sh.getByRole('button', { name: /^Run in a shell in / }).click();
  await until(async () => (await capture(shell.uid)).split('\nsnippets-ran').length === 3, 15_000, 'the second run’s output');
  assert.equal((await shellsHere()).length, 1);
  assert.equal(await page.locator('.pane').count(), 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: Run is always there, and the shell opens in the conversation’s place', { skip, timeout: 60_000 }, async () => {
  const { ctx, page, errors } = await open({ ...devices['iPhone 15'] });
  const sh = page.locator('.code-snippet', { has: page.locator('code.language-sh') });
  const run = sh.getByRole('button', { name: 'Run in Terminal' });
  assert.equal(await run.isVisible(), true, 'visible without hover');
  await run.tap();
  await sh.getByRole('button', { name: /^Run in a shell in / }).tap();
  const [shell] = await shellsHere();
  await until(() => page.url().endsWith(`#${shell.uid}`), 15_000, `the shell in its place (at ${page.url()})`);
  assert.equal(await page.getByText('snippets-ran').count(), 0, 'the conversation gave its place');
  if (shots) {
    // Once the split (or the page's fade) has settled and the shell has drawn.
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(shots, 'phone.png') });
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});
