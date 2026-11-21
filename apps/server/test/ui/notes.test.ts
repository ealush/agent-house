// Notes in the real page (web/NotesView.tsx, web/notes.ts) against a real host: written in
// the browser and kept on the host; a note from another device arrives on its own; two
// devices changing one note apart are both kept and the person chooses; a phone walks
// list → note → back. AH_UI_SHOTS=<dir> saves screenshots.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser, type Page } from 'playwright-core';
import { cleanup, http, until } from '../helpers.ts';
import { launch, startBed, transcriptOf } from '../fake-agents.ts';

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

const hostNotes = async () => (await http(ah, 'GET', '/api/notes?since=0')).json().notes as Array<{ id: string; title: string; markdown: string; revision: number; deleted: boolean; project: { host: string; path: string } | null; exports: Array<{ path: string }> }>;

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

test('desktop: a note written in the page is kept on the host; one from another device arrives; a conflict keeps both', { skip, timeout: 120_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${ah.port}/`, { waitUntil: 'networkidle' });

  await page.locator('.nav-item', { hasText: 'Notes' }).click();
  await page.locator('h1.page-title', { hasText: 'Notes' }).waitFor();
  await page.getByText('No notes yet').waitFor();
  await shot(page, 'notes-1-empty.png');

  await page.locator('.page-head').getByRole('button', { name: 'New note' }).click();
  const text = page.getByRole('textbox', { name: 'Note', exact: true });
  await text.waitFor();
  await text.pressSequentially('# Release plan\n\n- cut the branch');
  await text.press('Enter');
  await text.pressSequentially('write the notes');
  // Return carried the list on.
  assert.equal(await text.inputValue(), '# Release plan\n\n- cut the branch\n- write the notes');
  await page.locator('.note-row', { hasText: 'Release plan' }).waitFor();
  const [made] = await until(async () => {
    const n = await hostNotes();
    return n.length === 1 && n[0].markdown.endsWith('write the notes') ? n : null;
  }, 10_000, 'the note on the host');
  await page.locator('.note-foot', { hasText: 'On the host' }).waitFor();
  assert.match(page.url(), new RegExp(`#notes/${made.id}$`));
  await shot(page, 'notes-2-editor.png');

  await page.getByRole('radio', { name: 'Preview' }).click();
  await page.locator('.note-preview h1', { hasText: 'Release plan' }).waitFor();
  assert.equal(await page.locator('.note-preview li').count(), 2);
  await shot(page, 'notes-3-preview.png');
  await page.getByRole('radio', { name: 'Edit' }).click();

  // Another device writes a note: the stream's cursor moves and the page pulls it.
  const other = randomUUID();
  const put = await http(ah, 'PUT', `/api/notes/${other}`, { body: { baseRevision: 0, writeId: randomUUID(), title: 'From the phone', markdown: 'Jotted on the train.', project: null } });
  assert.equal(put.status, 201, put.body);
  await page.locator('.note-row', { hasText: 'From the phone' }).waitFor({ timeout: 10_000 });

  // Changed apart: this page can't reach the host while the phone writes.
  await page.route('**/api/notes/**', (r) => r.abort());
  await text.click();
  await text.press('End');
  await text.pressSequentially(' (laptop)');
  await page.waitForTimeout(1600);
  const revision = (await hostNotes()).find((n) => n.id === made.id)!.revision;
  const theirs = await http(ah, 'PUT', `/api/notes/${made.id}`, { body: { baseRevision: revision, writeId: randomUUID(), title: '', markdown: '# Release plan\n\n- cut the branch\n- tag it (phone)', project: null } });
  assert.equal(theirs.status, 200, theirs.body);
  await page.unroute('**/api/notes/**');
  const banner = page.locator('.note-conflict');
  await banner.waitFor({ timeout: 15_000 });
  assert.match(await banner.innerText(), /Changed on another device too/);
  await banner.locator('summary').click();
  await shot(page, 'notes-4-conflict.png');
  await banner.getByRole('button', { name: 'Keep both' }).click();
  await banner.waitFor({ state: 'detached' });
  assert.equal(await text.inputValue(), '# Release plan\n\n- cut the branch\n- tag it (phone)');
  await page.locator('.note-row', { hasText: "this device's version" }).waitFor();
  await until(async () => (await hostNotes()).some((n) => n.markdown.endsWith('write the notes (laptop)') && !n.deleted), 10_000, "this device's version on the host");

  // The palette finds a note by name.
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('From the phone');
  await page.getByRole('option', { name: /From the phone/ }).waitFor();
  await shot(page, 'notes-5-palette.png');
  await page.keyboard.press('Enter');
  await until(async () => (await text.inputValue()) === 'Jotted on the train.', 5000, 'the palette opened the note');

  // Delete asks first, and leaves a tombstone on the host.
  await page.locator('.note-bar').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await page.locator('.note-row', { hasText: 'From the phone' }).waitFor({ state: 'detached' });
  await until(async () => (await hostNotes()).find((n) => n.id === other)?.deleted, 10_000, 'tombstone');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: the list, a note, and back to the list', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 15'], defaultBrowserType: undefined } as Parameters<Browser['newContext']>[0]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${ah.port}/`, { waitUntil: 'networkidle' });
  // No sidebar on a phone: the Inbox's header has the way in.
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.locator('.note-row', { hasText: 'Release plan' }).first().waitFor();
  await shot(page, 'notes-6-phone-list.png');
  await page.locator('.note-row', { hasText: 'Release plan' }).first().click();
  const text = page.getByRole('textbox', { name: 'Note', exact: true });
  await text.waitFor();
  assert.equal(await page.locator('h1.page-title').count(), 0, 'the note takes the screen');
  await shot(page, 'notes-7-phone-note.png');
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.locator('h1.page-title', { hasText: 'Notes' }).waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('desktop: a note filed under a project, sent to its agent, put in a box, saved as a file, and a session started from it', { skip, timeout: 150_000 }, async () => {
  const agent = await launch(ah, 'claude', ah.project, 'Implement');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${ah.port}/#notes`, { waitUntil: 'networkidle' });
  await page.locator('.page-head').getByRole('button', { name: 'New note' }).click();
  const text = page.getByRole('textbox', { name: 'Note', exact: true });
  await text.waitFor();
  await text.fill('# Parser fix\n\nThe parser drops trailing commas. Keep them.');
  const more = page.locator('.note-bar').getByRole('button', { name: 'More' });

  // Filed under the project: listed under it, and on the host with it.
  await more.click();
  await shot(page, 'notes-8-menu.png');
  await page.getByRole('menuitem', { name: /File Under a Space/ }).click();
  const filing = page.getByRole('dialog', { name: 'Space' });
  await filing.getByRole('combobox').selectOption({ label: `proj · ${ah.project}` });
  await filing.getByRole('button', { name: 'Done' }).click();
  await page.locator('.notes-group', { hasText: 'proj' }).locator('.note-row', { hasText: 'Parser fix' }).waitFor();
  const note = await until(async () => (await hostNotes()).find((n) => n.markdown.startsWith('# Parser fix') && n.project?.path === ah.project), 10_000, 'filed on the host');

  // Sent to the project's agent, which is chosen for you.
  await page.locator('.note-bar').getByRole('button', { name: 'Send to an agent' }).click();
  const send = page.getByRole('dialog', { name: 'Send to an agent' });
  assert.match(await send.getByRole('combobox').locator('option:checked').innerText(), /Implement/);
  await shot(page, 'notes-9-send.png');
  await send.getByRole('button', { name: /^Send/ }).click();
  await send.waitFor({ state: 'detached' });
  await until(async () => (await transcriptOf(ah, agent.uid))?.includes('drops trailing commas'), 15_000, 'the note at the agent');
  assert.equal((await hostNotes()).find((n) => n.id === note.id)!.markdown, note.markdown, 'handing it on leaves the note as it was');

  // Saved as a file; again, the host's suggestion for a name not taken.
  for (const name of ['parser-fix.md', 'parser-fix (1).md']) {
    await more.click();
    await page.getByRole('menuitem', { name: 'Save as File…' }).click();
    const save = page.getByRole('dialog', { name: 'Save as file' });
    assert.equal(await save.getByRole('textbox').inputValue(), 'parser-fix.md');
    await save.getByRole('button', { name: /^Save/ }).click();
    if (name !== 'parser-fix.md') {
      await save.getByText('parser-fix.md is already there.').waitFor();
      await shot(page, 'notes-10-file-exists.png');
      await save.getByRole('button', { name: `Use ${name}` }).click();
      await save.getByRole('button', { name: /^Save/ }).click();
    }
    await save.waitFor({ state: 'detached' });
    assert.equal(readFileSync(join(ah.project, name), 'utf8'), note.markdown);
  }
  await page.locator('.note-foot', { hasText: 'Saved as' }).waitFor();

  // Put in the box: a draft is there already, so it asks; Add Below keeps both and opens the session.
  await http(ah, 'PUT', `/api/sessions/${agent.uid}/draft`, { body: { text: 'Before that:', device: 'test', client: 'test' } });
  await more.click();
  await page.getByRole('menuitem', { name: /Put in a Session's Box/ }).click();
  const box = page.getByRole('dialog', { name: "Put in a session's box" });
  await box.getByRole('button', { name: /^Put in Box/ }).click();
  await box.getByText('has a draft in its box').waitFor();
  await shot(page, 'notes-11-box-ask.png');
  await box.getByRole('button', { name: /^Add Below/ }).click();
  await until(async () => (await http(ah, 'GET', `/api/sessions/${agent.uid}/draft`)).json().draft?.text === `Before that:\n\n${note.markdown}`, 10_000, 'both in the box');
  // The session opens, where the draft is.
  await page.waitForURL(new RegExp(`#${agent.uid}$`));

  // Back to the note: New session there, the note its first message.
  await page.locator('.nav-item', { hasText: 'Notes' }).click();
  await page.locator('.note-row', { hasText: 'Parser fix' }).click();
  await page.locator('.note-bar').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: /Start a Session from This/ }).click();
  const prompt = page.locator('#ns-prompt');
  await prompt.waitFor();
  assert.equal(await prompt.inputValue(), note.markdown);
  await shot(page, 'notes-12-new-session.png');
  assert.deepEqual(errors, []);
  await ctx.close();
});
