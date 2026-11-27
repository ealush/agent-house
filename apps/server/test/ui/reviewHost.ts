// A disposable host for Review's page tests: a real ah with this checkout's page, a stand-in
// GitHub (`gh` on PATH, pull requests in a JSON file, a real git remote) and a chain of three
// pull requests on it, main ← #1 base ← #2 feat ← #3 docs, made a stack in review.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContextOptions } from 'playwright-core';
import { startAh, cleanup, http, type Ah } from '../helpers.ts';
import { pr, world } from '../reviewWorld.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
export const chrome = [process.env.AH_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome-stable'].find((p) => p && existsSync(p));

export type GhPr = { number: number; state: string; isDraft: boolean; baseRefName: string };
export type ReviewHost = {
  ah: Ah;
  browser: Browser;
  stackId: string;
  /** The stand-in GitHub's pull requests, as they are now. */
  prs: () => GhPr[];
  /** What the stand-in GitHub has been asked, one call a line. */
  ghLog: () => string;
  /** What the stand-in agent has been typed (with `agent`). */
  agentInput: () => string;
  /** The reviews posted on the stand-in GitHub. */
  reviews: () => { n: number; body: string; comments: { path: string; line: number; body: string }[] }[];
  open: (options: BrowserContextOptions, hash: string, theme?: string) => Promise<{ ctx: import('playwright-core').BrowserContext; page: import('playwright-core').Page; errors: string[] }>;
  stop: () => Promise<void>;
};

/**
 * `extra` changes each pull request as GitHub has it. `agent`: an agent session in the
 * checkout (a stand-in that writes what it's sent to `agentInput()`), for sends to go to.
 */
export async function reviewHost(extra: (p: Record<string, unknown>) => Record<string, unknown> = (p) => p, opts: { agent?: boolean } = {}): Promise<ReviewHost> {
  const scratch = mkdtempSync(join(tmpdir(), 'ah-review-ui-'));
  const heard = join(scratch, 'agent-input.txt');
  const agent = join(scratch, 'agent.mjs');
  // Not an agent: it keeps what it's typed, the way a session would read it.
  writeFileSync(agent, `import { appendFileSync } from 'node:fs';\nprocess.stdin.on('data', (d) => appendFileSync(${JSON.stringify(heard)}, d));\nconsole.log('READY');\nsetInterval(() => {}, 1 << 30);\n`);
  const w = await world(scratch);
  w.g('checkout', '-q', '-b', 'base');
  await w.commit('b.ts', 'export const b = 1;\n', 'base');
  const h1 = w.publish('base', 1);
  w.g('checkout', '-q', '-b', 'feat');
  await w.commit('c.ts', 'export const c = () => 1;\n', 'feat');
  const h2 = w.publish('feat', 2);
  w.g('checkout', '-q', '-b', 'docs');
  await w.commit('README.md', '# c\n', 'docs');
  const h3 = w.publish('docs', 3);
  const prs = [pr(1, 'base', 'main', h1, { title: 'Add b' }), pr(2, 'feat', 'base', h2, { title: 'Add c' }), pr(3, 'docs', 'feat', h3, { title: 'Document c' })].map(extra);
  writeFileSync(w.stateFile, JSON.stringify({ prs, threads: [], remote: w.remote }));

  const dist = join(scratch, 'dist');
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });
  const saved = { AH_DIST: process.env.AH_DIST, PATH: process.env.PATH, AH_GH_STATE: process.env.AH_GH_STATE };
  process.env.AH_DIST = dist;
  process.env.PATH = `${w.bin}:${saved.PATH}`;
  process.env.AH_GH_STATE = w.stateFile;
  let ah: Ah;
  try {
    ah = await startAh({ auth: { mode: 'off' }, projectRoots: [w.local], ...(opts.agent ? { idleAfter: 1, presets: [{ id: 'claude', name: 'Fixer', command: `exec ${process.execPath} ${agent}`, match: '^node$', feed: 'claude' }] } : {}) });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const made = await http(ah, 'POST', '/api/review/stacks', { body: { root: w.local, pr: 1 } });
  if (made.status !== 200) throw new Error(`stack: ${made.status} ${made.body}`);
  if (opts.agent) {
    const made = await http(ah, 'POST', '/api/windows', { body: { preset: 'claude', cwd: w.local, label: 'Fixer' } });
    if (made.status !== 201) throw new Error(`agent: ${made.status} ${made.body}`);
  }
  const browser = await chromium.launch({ executablePath: chrome });
  return {
    agentInput: () => (existsSync(heard) ? readFileSync(heard, 'utf8') : ''),
    ah,
    browser,
    stackId: made.json().id,
    prs: () => JSON.parse(readFileSync(w.stateFile, 'utf8')).prs,
    reviews: () => JSON.parse(readFileSync(w.stateFile, 'utf8')).reviews ?? [],
    ghLog: () => (existsSync(`${w.stateFile}.log`) ? readFileSync(`${w.stateFile}.log`, 'utf8') : ''),
    open: async (options, hash, theme = 'light') => {
      for (const previous of browser.contexts()) await previous.close();
      const ctx = await browser.newContext(options);
      const errors: string[] = [];
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript((t) => {
        localStorage.setItem('ah.view', 'gui');
        localStorage.setItem('ah.theme', t);
      }, theme);
      await page.goto(`http://localhost:${ah.port}/#${hash}`, { waitUntil: 'domcontentloaded' });
      return { ctx, page, errors };
    },
    stop: async () => {
      await browser.close();
      await cleanup(ah);
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

export const shotsDir = (name: string) => {
  const dir = process.env[name];
  if (dir) mkdirSync(dir, { recursive: true });
  return dir;
};
