// A draft keeps its files: real page → disposable host → a draft another device left with a
// picture in it. No production state.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { startAh, cleanup, http, until, type Ah } from '../helpers.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const chrome = [process.env.AH_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome-stable'].find((p) => p && existsSync(p));
const skip = chrome ? false : 'no Chromium';
const photo = '/home/me/.cache/ah/uploads/2026-11-22T13-48-32-149Z-photo.png';
let ah: Ah;
let browser: Browser;
let scratch: string;
let uid: string;

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(join(tmpdir(), 'ah-draft-files-'));
  const agent = join(scratch, 'agent.mjs');
  writeFileSync(
    agent,
    `import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const id = randomUUID();
const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
const write = (type, content, n) => appendFileSync(join(dir, id + '.jsonl'), JSON.stringify({ type, uuid: type + '-' + n, sessionId: id, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: type, content } }) + '\\n');
write('user', [{ type: 'text', text: 'Hello' }], 1);
write('assistant', [{ type: 'text', text: 'Ready when you are.' }], 2);
console.log('READY');
setInterval(() => {}, 1 << 30);
`,
  );
  const dist = join(scratch, 'dist');
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });
  const saved = process.env.AH_DIST;
  process.env.AH_DIST = dist;
  try {
    ah = await startAh({ auth: { mode: 'off' }, idleAfter: 1, presets: [{ id: 'claude', name: 'Draft test', command: `exec ${process.execPath} ${agent}`, match: '^node$', feed: 'claude' }] });
  } finally {
    if (saved === undefined) delete process.env.AH_DIST;
    else process.env.AH_DIST = saved;
  }
  const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'claude', cwd: `${ah.dir}/files`, label: 'Draft test' } });
  assert.equal(created.status, 201, created.body);
  uid = created.json().uid;
  await until(async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid && w.harnessId), 20_000, 'the transcript');
  browser = await chromium.launch({ executablePath: chrome });
});

after(async () => {
  await browser?.close();
  if (ah) await cleanup(ah);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test('a draft left with a picture comes back with it, as a tile and its chip, and saves its path again', { skip, timeout: 60_000 }, async () => {
  // Left on another device: the words, and the picture's path where its chip was.
  const put = await http(ah, 'PUT', `/api/sessions/${uid}/draft`, { body: { text: `after I answered ${photo} nothing showed`, device: 'iPhone', client: 'another-device' } });
  assert.equal(put.status, 200, put.body);
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('ah.view', 'gui'));
  await page.goto(`http://localhost:${ah.port}/#${uid}`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Ready when you are.').waitFor({ timeout: 20_000 });
  const box = page.locator('.composer textarea');
  await until(async () => (await box.inputValue()) === 'after I answered @photo.png nothing showed', 20_000, 'the draft in the box, its chip in its place');
  assert.equal(await page.locator('.composer-file').count(), 1, 'the picture is a tile again');
  // Typed on here: the host's copy is the message it would send, its path still in it.
  await box.press('End');
  await box.pressSequentially(' again');
  await until(async () => (await http(ah, 'GET', `/api/sessions/${uid}/draft`)).json().draft?.text === `after I answered ${photo} nothing showed again`, 5_000, 'the draft saved with its path');
  assert.deepEqual(errors, []);
});
