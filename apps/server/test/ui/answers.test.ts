// Your answers to the agent's questions stay in the chat: real page → disposable host → a
// Claude-shaped transcript with a question you answered. No production state.
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
let ah: Ah;
let browser: Browser;
let scratch: string;
let uid: string;

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(join(tmpdir(), 'ah-answers-'));
  // A step, then two questions answered through the dialog, as Claude Code writes them.
  const questions = [
    { question: 'Who may write in the main checkout?', header: 'Writers', multiSelect: false, options: [{ label: 'Warn, don’t block', description: 'Say who else is there' }, { label: 'Block' }] },
    { question: 'Which worktrees may ah delete?', header: 'Cleanup', multiSelect: false, options: [{ label: 'Only ones ah created' }, { label: 'All under .worktrees' }] },
  ];
  const answers = { 'Who may write in the main checkout?': 'Warn, don’t block', 'Which worktrees may ah delete?': 'Only ones ah created' };
  const agent = join(scratch, 'agent.mjs');
  writeFileSync(
    agent,
    `import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const id = randomUUID();
const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
let n = 0;
const write = (type, content, extra = {}) => appendFileSync(join(dir, id + '.jsonl'), JSON.stringify({ type, uuid: type + '-' + ++n, sessionId: id, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: type, content }, ...extra }) + '\\n');
write('user', [{ type: 'text', text: 'Plan the checkouts work' }]);
write('assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'plan.md' } }, { type: 'tool_use', id: 'toolu_2', name: 'AskUserQuestion', input: { questions: ${JSON.stringify(questions)} } }]);
write('user', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'the plan', is_error: false }]);
write('user', [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'Your questions have been answered.', is_error: false }], { toolUseResult: { questions: ${JSON.stringify(questions)}, answers: ${JSON.stringify(answers)} } });
write('assistant', [{ type: 'text', text: 'Going with those.' }]);
console.log('READY');
setInterval(() => {}, 1 << 30);
`,
  );
  const dist = join(scratch, 'dist');
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });
  const saved = process.env.AH_DIST;
  process.env.AH_DIST = dist;
  try {
    ah = await startAh({ auth: { mode: 'off' }, idleAfter: 1, presets: [{ id: 'claude', name: 'Answers test', command: `exec ${process.execPath} ${agent}`, match: '^node$', feed: 'claude' }] });
  } finally {
    if (saved === undefined) delete process.env.AH_DIST;
    else process.env.AH_DIST = saved;
  }
  const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'claude', cwd: `${ah.dir}/files`, label: 'Answers test' } });
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

async function open(steps: 'hidden' | 'shown') {
  for (const previous of browser.contexts()) await previous.close();
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((steps) => {
    localStorage.setItem('ah.view', 'gui');
    localStorage.setItem('ah.steps', steps);
  }, steps);
  await page.goto(`http://localhost:${ah.port}/#${uid}`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Going with those.').waitFor({ timeout: 20_000 });
  return { page, errors };
}

test('steps hidden: the read folds to one line, the questions you answered stay with your answers', { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await open('hidden');
  await page.getByText('Answer: Warn, don’t block').waitFor({ timeout: 5_000 });
  await page.getByText('Answer: Only ones ah created').waitFor({ timeout: 5_000 });
  // The fold counts the read alone; the question isn't a step inside it.
  assert.deepEqual(await page.locator('.tool-fold').allInnerTexts().then((t) => t.map((s) => s.replace(/\s+/g, ' ').replace('›', '').trim())), ['1 step']);
  assert.deepEqual(errors, []);
});

test('steps shown: an answered question is open, its answers there without a click', { skip, timeout: 60_000 }, async () => {
  const { page, errors } = await open('shown');
  await page.getByText('Answer: Warn, don’t block').waitFor({ timeout: 5_000 });
  await page.getByText('Answer: Only ones ah created').waitFor({ timeout: 5_000 });
  assert.equal(await page.locator('.tool-fold').count(), 0);
  assert.deepEqual(errors, []);
});
