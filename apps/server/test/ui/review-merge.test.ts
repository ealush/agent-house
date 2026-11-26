// Merging from the Review list: real page → disposable host → a stand-in GitHub (`gh` on
// PATH, pull requests in a JSON file, a real git remote). A stack's card merges just the
// next layer, or the whole stack, without opening the stack first. No production state.
import '../scratch.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser, type BrowserContextOptions } from 'playwright-core';
import { startAh, cleanup, http, until, type Ah } from '../helpers.ts';
import { pr, world } from '../reviewWorld.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const chrome = [process.env.AH_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome-stable'].find((p) => p && existsSync(p));
const skip = chrome ? false : 'no Chromium';
const shots = process.env.AH_REVIEW_MERGE_SHOTS;
let ah: Ah;
let browser: Browser;
let scratch: string;
let w: Awaited<ReturnType<typeof world>>;
let stackId: string;

const prs = () => JSON.parse(readFileSync(w.stateFile, 'utf8')).prs as { number: number; state: string }[];
const stateOf = (n: number) => prs().find((p) => p.number === n)?.state;

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(join(tmpdir(), 'ah-review-merge-'));
  // main ← #1 base ← #2 feat ← #3 docs, with checks passing on each.
  w = await world(scratch);
  w.g('checkout', '-q', '-b', 'base');
  await w.commit('b.ts', 'export const b = 1;\n', 'base');
  const h1 = w.publish('base', 1);
  w.g('checkout', '-q', '-b', 'feat');
  await w.commit('c.ts', 'export const c = () => 1;\n', 'feat');
  const h2 = w.publish('feat', 2);
  w.g('checkout', '-q', '-b', 'docs');
  await w.commit('README.md', '# c\n', 'docs');
  const h3 = w.publish('docs', 3);
  writeFileSync(w.stateFile, JSON.stringify({ prs: [pr(1, 'base', 'main', h1, { title: 'Add b' }), pr(2, 'feat', 'base', h2, { title: 'Add c' }), pr(3, 'docs', 'feat', h3, { title: 'Document c' })], threads: [], remote: w.remote }));

  const dist = join(scratch, 'dist');
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });
  const saved = { AH_DIST: process.env.AH_DIST, PATH: process.env.PATH, AH_GH_STATE: process.env.AH_GH_STATE };
  process.env.AH_DIST = dist;
  process.env.PATH = `${w.bin}:${saved.PATH}`;
  process.env.AH_GH_STATE = w.stateFile;
  try {
    ah = await startAh({ auth: { mode: 'off' }, projectRoots: [w.local] });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const made = await http(ah, 'POST', '/api/review/stacks', { body: { root: w.local, pr: 1 } });
  assert.equal(made.status, 200, made.body);
  stackId = made.json().id;
  assert.deepEqual(made.json().layers.map((l: { pr: number }) => l.pr), [1, 2, 3]);
  browser = await chromium.launch({ executablePath: chrome });
  if (shots) mkdirSync(shots, { recursive: true });
});

after(async () => {
  await browser?.close();
  if (ah) await cleanup(ah);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function open(options: BrowserContextOptions, theme = 'light') {
  for (const previous of browser.contexts()) await previous.close();
  const ctx = await browser.newContext(options);
  const errors: string[] = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((t) => {
    localStorage.setItem('ah.view', 'gui');
    localStorage.setItem('ah.theme', t);
  }, theme);
  await page.goto(`http://localhost:${ah.port}/#review`, { waitUntil: 'domcontentloaded' });
  const card = page.locator('.stack-card-wrap').filter({ hasText: 'me/proj' });
  await card.waitFor({ timeout: 20_000 });
  return { ctx, page, card, errors };
}

test('desktop: a stack card merges just the next layer, and the rest stays in review', { skip, timeout: 120_000 }, async () => {
  const { ctx, page, card, errors } = await open({ viewport: { width: 1280, height: 860 } });
  if (shots) await page.screenshot({ path: join(shots, 'desktop-list.png') });
  await card.getByRole('button', { name: /^Merge / }).click();
  const dialog = page.locator('dialog.review-merge-stack');
  await dialog.waitFor();
  // Nothing marked reviewed yet: merging marks what lands, and all three can.
  const scope = dialog.getByRole('radiogroup', { name: 'What lands' });
  await scope.getByRole('radio', { name: 'All 3' }).waitFor();
  assert.equal(await scope.getByRole('radio', { name: 'All 3' }).getAttribute('aria-checked'), 'true', 'the whole stack, until you say otherwise');
  if (shots) await dialog.screenshot({ path: join(shots, 'desktop-dialog-all.png') });
  await scope.getByRole('radio', { name: /^Just / }).click();
  assert.equal(await dialog.locator('.land-row.stays').count(), 2, 'the two above it stay');
  assert.match((await dialog.locator('.land-row.stays .land-note').first().textContent()) ?? '', /Stays in review/);
  if (shots) await dialog.screenshot({ path: join(shots, 'desktop-dialog-next.png') });
  await dialog.getByRole('button', { name: /^Mark reviewed & merge/ }).click();
  await dialog.waitFor({ state: 'detached', timeout: 60_000 });
  assert.equal(stateOf(1), 'MERGED');
  assert.equal(stateOf(2), 'OPEN', 'only the next layer landed');
  assert.equal(stateOf(3), 'OPEN');
  await until(async () => /1 of 3 merged/.test((await card.textContent()) ?? ''), 20_000, 'the card says one landed');
  if (shots) await page.screenshot({ path: join(shots, 'desktop-list-after.png') });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: the same card merges what is left of the stack, in a sheet', { skip, timeout: 120_000 }, async () => {
  const { ctx, page, card, errors } = await open(devices['iPhone 15 Pro'], 'dark');
  await card.getByRole('button', { name: /^Merge / }).tap();
  const dialog = page.locator('dialog.review-merge-stack');
  await dialog.waitFor();
  await dialog.getByRole('radio', { name: 'All 2' }).waitFor();
  if (shots) await page.waitForTimeout(500).then(() => page.screenshot({ path: join(shots, 'phone-dialog.png') }));
  await dialog.getByRole('button', { name: /^Mark reviewed & merge all 2/ }).tap();
  await dialog.waitFor({ state: 'detached', timeout: 60_000 });
  assert.deepEqual(prs().map((p) => p.state), ['MERGED', 'MERGED', 'MERGED']);
  // A stack with nothing left to merge moves to Done, and its card offers no merge.
  await until(async () => (await http(ah, 'GET', `/api/review/stacks/${stackId}`)).json().layers.every((l: { state: string }) => l.state === 'merged'), 20_000, 'every layer merged');
  assert.deepEqual(errors, []);
  await ctx.close();
});
