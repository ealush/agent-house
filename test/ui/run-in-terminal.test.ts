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

const windows = async () => (await http(ah, 'GET', '/api/state')).json().windows as Array<{ uid: string; id: string; terminal?: { id: string; busy: boolean } | null }>;
const terminal = async () => (await http(ah, 'GET', `/api/sessions/${uid}/terminal`)).json().terminal as { id: string; busy: boolean } | null;
const capture = (id: string) => ah.tmux('capture-pane', '-p', '-S', '-200', '-t', id);

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

test('desktop: Send to terminal runs beside the conversation, reuses its attachment, and adds no session', { skip, timeout: 90_000 }, async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 1440, height: 900 } });
  const before = (await windows()).length;
  const sh = page.locator('.code-snippet', { has: page.locator('code.language-sh') });
  const ts = page.locator('.code-snippet', { has: page.locator('code.language-ts') });
  assert.equal(await ts.locator('.code-run').count(), 0, 'TypeScript is not run');
  await sh.hover();
  await sh.getByRole('button', { name: 'Send to terminal' }).click();
  const shell = await until(terminal, 15_000, 'the attached shell');
  await until(() => capture(shell.id).includes('\nsnippets-ran'), 15_000, 'snippet output').catch((e) => { throw new Error(`${e.message}\nScreen: ${capture(shell.id)}\nHost: ${ah.log()}`); });
  await page.getByLabel('Attached terminal', { exact: true }).waitFor();
  assert.equal((await windows()).length, before, 'the shell has no session row');
  assert.equal(await page.locator('.pane').count(), 0, 'the attachment is a panel, not a workspace tile');
  if (shots) await page.screenshot({ path: join(shots, 'beside.png') });
  await until(async () => !(await terminal())?.busy, 10_000, 'shell ready');
  await sh.hover();
  await sh.getByRole('button', { name: 'Send to terminal' }).click();
  await until(() => capture(shell.id).split('\nsnippets-ran').length === 3, 15_000, 'second output');
  assert.equal((await terminal())?.id, shell.id);
  assert.equal((await windows()).length, before);
  // Hiding and reopening via the session menu keeps the same process.
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByLabel('Attached terminal', { exact: true }).waitFor();
  assert.equal((await terminal())?.id, shell.id);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: Send opens the attached terminal within its owner, and Session returns to the conversation', { skip, timeout: 60_000 }, async () => {
  const { ctx, page, errors } = await open({ ...devices['iPhone 15'] });
  const before = (await windows()).length;
  const sh = page.locator('.code-snippet', { has: page.locator('code.language-sh') });
  const run = sh.getByRole('button', { name: 'Send to terminal' });
  assert.equal(await run.isVisible(), true, 'visible without hover');
  const shell = await terminal();
  const count = shell ? capture(shell.id).split('\nsnippets-ran').length : 0;
  await run.tap();
  await page.getByLabel('Attached terminal', { exact: true }).waitFor();
  await until(async () => { const t = await terminal(); return t && capture(t.id).split('\nsnippets-ran').length > count; }, 15_000, 'phone snippet output');
  assert.ok(page.url().endsWith(`#${uid}`), 'navigation stays on the owner');
  assert.equal((await windows()).length, before);
  if (shots) await page.screenshot({ path: join(shots, 'phone.png') });
  await page.getByRole('tab', { name: 'Session', exact: true }).tap();
  await sh.waitFor({ state: 'visible' });
  assert.ok(await terminal(), 'hiding the panel leaves its shell running');
  assert.deepEqual(errors, []);
  await ctx.close();
});
