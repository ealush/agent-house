// Real page → disposable host → an agent that never takes the message: the queue tray
// says so (Not sent), and Send again / Let it go act on it. No production state.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser, type BrowserContextOptions } from 'playwright-core';
import { startAh, cleanup, http, until, sleep, type Ah } from '../helpers.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const chrome = [process.env.AH_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome-stable'].find((p) => p && existsSync(p));
const skip = chrome ? false : 'no Chromium';
const shots = process.env.AH_UNSENT_SHOTS;
const said = 'Write the spec and then build it';
let ah: Ah;
let browser: Browser;
let scratch: string;
let uid: string;
let win: string;

const queue = async (of = uid) => (await http(ah, 'GET', `/api/sessions/${of}/queue?unsent=1`)).json() as { id: string; text: string; unsent?: boolean }[];

/** A session of the agent below, its transcript adopted and past its first moments. */
async function session(label: string): Promise<{ uid: string; id: string }> {
  const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'claude', cwd: `${ah.dir}/files`, label } });
  assert.equal(created.status, 201, created.body);
  const s = created.json();
  await until(async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: { uid: string; harnessId?: string }) => w.uid === s.uid && w.harnessId), 20_000, 'its transcript adopted');
  await sleep(5500);
  return s;
}

/** Sends `said` into an agent whose box ah can't read and which takes no Enter for it, and waits for ah to give up on it. */
async function notSent(of = uid) {
  assert.equal((await http(ah, 'POST', `/api/sessions/${of}/send`, { body: { text: said } })).json().outcome, 'delivered');
  await until(async () => (await queue(of)).some((q) => q.unsent), 60_000, 'shown as not sent');
}

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(join(tmpdir(), 'ah-unsent-'));
  const boxed = fileURLToPath(new URL('../fixtures/boxed-agent.js', import.meta.url));
  const dist = join(scratch, 'dist');
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });
  const saved = process.env.AH_DIST;
  process.env.AH_DIST = dist;
  try {
    // Every odd paste is deaf: the first never goes in, nor does a Send again's retry alone.
    ah = await startAh({
      auth: { mode: 'off' },
      idleAfter: 1,
      presets: [{ id: 'claude', name: 'Gemini', command: `exec ${process.execPath} ${boxed} --transcript --turn=1000 --prompt=› --deaf=1`, match: '^node$', feed: 'claude' }],
    });
  } finally {
    if (saved === undefined) delete process.env.AH_DIST;
    else process.env.AH_DIST = saved;
  }
  ({ uid, id: win } = await session('Concurrent workspaces'));
  browser = await chromium.launch({ executablePath: chrome });
  if (shots) mkdirSync(shots, { recursive: true });
});

after(async () => {
  await browser?.close();
  if (ah) await cleanup(ah);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function open(options: BrowserContextOptions, theme: 'light' | 'dark', target = uid) {
  for (const previous of browser.contexts()) await previous.close();
  const page = await (await browser.newContext({ ...options, colorScheme: theme })).newPage();
  await page.addInitScript((theme) => { localStorage.setItem('ah.view', 'gui'); localStorage.setItem('ah.theme', theme); }, theme);
  await page.goto(`http://localhost:${ah.port}/#${target}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('form', { name: 'Message composer' }).waitFor();
  return page;
}

test('a message the agent never took shows in the queue tray as not sent, on a phone and a desktop', { skip, timeout: 180_000 }, async () => {
  await notSent();
  const sizes: [string, BrowserContextOptions][] = [['phone', devices['iPhone 15 Pro']], ['desktop', { viewport: { width: 1280, height: 800 } }]];
  for (const [name, options] of sizes) {
    for (const theme of ['light', 'dark'] as const) {
      const page = await open(options, theme);
      const row = page.locator('.queue-row.unsent');
      await row.waitFor();
      assert.equal(await row.locator('.queue-text').innerText(), said);
      assert.match(await row.locator('.queue-unsent').innerText(), /^Not sent/);
      assert.ok(await row.getByRole('button', { name: 'Send again' }).isVisible());
      assert.ok(await row.getByRole('button', { name: 'Let it go' }).isVisible());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
      if (shots) await page.screenshot({ path: join(shots, `unsent-${name}-${theme}.png`) });
    }
  }
});

test('Send again types it in again, and it reaches the agent', { skip, timeout: 180_000 }, async () => {
  if (!(await queue()).some((q) => q.unsent)) await notSent();
  const page = await open({ viewport: { width: 1280, height: 800 } }, 'light');
  await page.locator('.queue-row.unsent').getByRole('button', { name: 'Send again' }).click();
  await page.locator('.queue-row.unsent').waitFor({ state: 'detached', timeout: 15_000 });
  // The first is still in its box: typed again, the two go in as one message.
  await until(() => ah.tmux('capture-pane', '-p', '-J', '-t', win).includes(`RECEIVED:${said}`), 60_000, 'it reaches the agent');
  assert.deepEqual(await queue(), []);
});

test('Let it go takes it away', { skip, timeout: 180_000 }, async () => {
  const other = await session('Another');
  await notSent(other.uid);
  const page = await open({ viewport: { width: 1280, height: 800 } }, 'light', other.uid);
  await page.locator('.queue-row.unsent').getByRole('button', { name: 'Let it go' }).click();
  await page.locator('.queue-row.unsent').waitFor({ state: 'detached' });
  assert.deepEqual(await queue(other.uid), []);
});
