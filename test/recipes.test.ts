import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until, type Ah } from './helpers.ts';

const fixture = fileURLToPath(new URL('./fixtures/agent.js', import.meta.url));
const preset = { id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${fixture}`, match: '^node$' };
const recipe = {
  id: 'pair',
  name: 'Pair',
  members: [
    { key: 'builder', preset: 'test-agent', title: 'Builder', worktree: true, prompt: '{brief}' },
    { key: 'reviewer', preset: 'test-agent', title: 'Reviewer', cwdFrom: 'builder', prompt: 'wait for the handoff' },
  ],
  handoffs: [{ when: { session: 'builder', event: 'turn-end' }, sendTo: 'reviewer', template: 'review the work in {builder.worktree} on {builder.branch}' }],
};
const config = { auth: { mode: 'off' }, idleAfter: 1, presets: [preset], recipes: [recipe] };

function gitRepo(ah: Ah): string {
  const repo = join(ah.dir, 'files', 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  git('add', '.');
  git('commit', '-m', 'init');
  return repo;
}

async function launchPair(ah: Ah, repo: string) {
  const launched = await http(ah, 'POST', '/api/recipes/pair/launch', { body: { cwd: repo, brief: 'build the thing' } });
  assert.equal(launched.status, 201, launched.body);
  const out = launched.json();
  assert.equal(out.members.length, 2);
  return out;
}

test('a recipe launches a grouped team in a worktree and the handoff fires on turn end', async () => {
  const ah = await startAh(config);
  try {
    const repo = gitRepo(ah);
    const out = await launchPair(ah, repo);
    const runId = out.run.runId;
    const reviewer = out.members.find((m: any) => m.key === 'reviewer');

    // Sidebar state: both members carry the run, the builder sits in a worktree.
    const state = (await http(ah, 'GET', '/api/state')).json();
    const members = state.windows.filter((w: any) => w.run?.runId === runId);
    assert.equal(members.length, 2);
    const builderWin = members.find((w: any) => w.run.key === 'builder');
    assert.ok(builderWin.cwd.includes('.worktrees'), builderWin.cwd);
    assert.equal(builderWin.worktree, true);
    assert.ok(state.runs.some((r: any) => r.runId === runId && r.state === 'running'));

    const runBefore = (await http(ah, 'GET', `/api/runs/${runId}`)).json();
    const builderMember = runBefore.members.find((m: any) => m.key === 'builder');
    assert.match(builderMember.branch, /^ah\//);
    assert.equal(runBefore.handoffs[0].state, 'pending');

    // The builder got the brief; when its turn ends, the reviewer gets the
    // handoff with the worktree path and ah/ branch resolved.
    await until(() => ah.tmux('capture-pane', '-p', '-t', reviewer.id).includes('FINISHED:review the work in'), 25000, 'handoff delivered to reviewer');
    const screen = ah.tmux('capture-pane', '-p', '-t', reviewer.id);
    assert.ok(screen.includes('RECEIVED:review the work in'), screen);
    assert.ok(/ah\/[a-z0-9-]+/.test(screen), screen);
    await until(async () => (await http(ah, 'GET', `/api/runs/${runId}`)).json().handoffs[0].state === 'delivered', 10000, 'handoff marked delivered');

    // Stopping the run stops every member.
    assert.equal((await http(ah, 'POST', `/api/runs/${runId}/stop`, { body: {} })).status, 200);
    await until(async () => (await http(ah, 'GET', '/api/state')).json().windows.filter((w: any) => w.run?.runId === runId).length === 0, 10000, 'run members stopped');
    assert.equal((await http(ah, 'GET', `/api/runs/${runId}`)).json().state, 'stopped');
  } finally {
    await cleanup(ah);
  }
});

test('a pending handoff survives a server restart and still fires', async () => {
  let ah = await startAh(config);
  try {
    const repo = gitRepo(ah);
    const out = await launchPair(ah, repo);
    const runId = out.run.runId;
    const reviewer = out.members.find((m: any) => m.key === 'reviewer');
    ah = await ah.restart();
    await until(() => ah.tmux('capture-pane', '-p', '-t', reviewer.id).includes('FINISHED:review the work in'), 30000, 'handoff delivered after restart');
    await until(async () => (await http(ah, 'GET', `/api/runs/${runId}`)).json().handoffs[0].state === 'delivered', 10000, 'handoff delivered once');
  } finally {
    await cleanup(ah);
  }
});

test('an invalid recipe is rejected with the specific problem, and an empty brief is blocked', async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [preset],
    recipes: [{ id: 'broken', name: 'Broken', members: [{ key: 'a', preset: 'test-agent', prompt: 'see {ghost.cwd}' }, { key: 'b', preset: 'test-agent' }] }],
  });
  try {
    const list = (await http(ah, 'GET', '/api/recipes')).json();
    const broken = list.find((r: any) => r.id === 'broken');
    assert.ok(broken.errors.some((e: string) => e.includes('{ghost.cwd}')), JSON.stringify(broken.errors));
    const launched = await http(ah, 'POST', '/api/recipes/broken/launch', { body: { cwd: `${ah.dir}/files`, brief: 'x' } });
    assert.equal(launched.status, 400);
    assert.match(launched.body, /ghost\.cwd/);

    const saved = await http(ah, 'PUT', '/api/recipes', {
      body: { recipes: [{ id: 'bad', name: 'Bad', members: [{ key: 'a', preset: 'ghost' }, { key: 'b', preset: 'test-agent' }] }] },
    });
    assert.equal(saved.status, 400);
    assert.match(saved.body, /unknown preset/);
    assert.match(saved.body, /ghost/);
  } finally {
    await cleanup(ah);
  }
});

test('launching a brief-only recipe without a brief fails and launches nothing', async () => {
  const ah = await startAh(config);
  try {
    const repo = gitRepo(ah);
    const launched = await http(ah, 'POST', '/api/recipes/pair/launch', { body: { cwd: repo, brief: '' } });
    assert.equal(launched.status, 400, launched.body);
    assert.match(launched.body, /needs a brief/);
    const state = (await http(ah, 'GET', '/api/state')).json();
    assert.equal(state.windows.filter((w: any) => w.run).length, 0);
  } finally {
    await cleanup(ah);
  }
});

test('a later member launch failure removes all windows and worktrees created by the run', async () => {
  const ah = await startAh(config);
  try {
    const repo = gitRepo(ah);
    const before = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    const launched = await http(ah, 'POST', '/api/recipes/pair/launch', {
      body: { cwd: repo, brief: 'x', overrides: { reviewer: { mode: 'nonexistent' } } },
    });
    assert.equal(launched.status, 400, launched.body);
    const state = (await http(ah, 'GET', '/api/state')).json();
    assert.equal(state.windows.filter((w: any) => w.run).length, 0);
    assert.equal(execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }), before);
  } finally {
    await cleanup(ah);
  }
});
