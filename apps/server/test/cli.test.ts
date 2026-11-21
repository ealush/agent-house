// The CLI drives sessions the way the web does (spec CLI): agents driving agents need to
// answer, stop, terminate, rename and pin, and to name a session by its title.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, signIn, until, type Ah } from './helpers.ts';

const CLI = fileURLToPath(new URL('../bin/ah.js', import.meta.url));
let ah: Ah;
let cookie: string;
const bin = join(process.env.TMPDIR ?? '/tmp', `ah-cli-bin-${process.pid}`);

// A stand-in agent named `claude`, so ah detects it, drawing Claude's permission prompt.
const FAKE_CLAUDE = `#!/bin/bash
printf ' Bash command\\n\\n   rm -rf build\\n   Remove the build folder\\n\\n Do you want to proceed?\\n ❯ 1. Yes\\n   2. No\\n'
IFS= read -rsn1 key
printf '\\033[2J\\033[Hanswered %s\\n' "$key"
sleep 600
`;

before(async () => {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  chmodSync(join(bin, 'claude'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    ah = await startAh();
  } finally {
    process.env.PATH = path;
  }
  cookie = await signIn(ah);
});
after(async () => {
  await cleanup(ah);
  rmSync(bin, { recursive: true, force: true });
});

function ahCli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...ah.env, AH_PORT: String(ah.port) } }, (e, out, err) =>
      resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }),
    );
  });
}

const windows = async () => (await http(ah, 'GET', '/api/state', { cookie })).json().windows as Array<{ uid: string; id: string; title: string; name: string; pinned: boolean; status: string }>;

test('rename, pin and terminate a session by title', async () => {
  const created = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files`, label: 'cli target' } });
  const { uid } = created.json();
  await until(async () => (await windows()).some((w) => w.uid === uid), 8000, 'in state');

  let r = await ahCli('rename', 'cli target', 'renamed', 'by', 'cli');
  assert.equal(r.code, 0, r.err);
  await until(async () => (await windows()).find((w) => w.uid === uid)?.title === 'renamed by cli', 8000, 'renamed');

  r = await ahCli('pin', 'renamed by');
  assert.equal(r.code, 0, r.err);
  await until(async () => (await windows()).find((w) => w.uid === uid)?.pinned === true, 8000, 'pinned');
  r = await ahCli('pin', uid, '--off');
  assert.equal(r.code, 0, r.err);
  await until(async () => (await windows()).find((w) => w.uid === uid)?.pinned === false, 8000, 'unpinned');

  r = await ahCli('list');
  assert.match(r.out, /renamed by cli/);
  assert.match(r.out, /○ idle|◌ working|◆ new output/);

  r = await ahCli('answer', uid, 'yes');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /isn't waiting/);

  r = await ahCli('stop', uid);
  assert.equal(r.code, 0, r.err);

  r = await ahCli('terminate', uid);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ah resume/);
  await until(async () => !(await windows()).some((w) => w.uid === uid), 8000, 'gone');
});

test('answer a waiting agent by option number', async () => {
  const created = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'claude', cwd: `${ah.dir}/files`, label: 'asks' } });
  assert.equal(created.status, 201, created.body);
  const { uid, id } = created.json();
  await until(async () => (await windows()).find((w) => w.uid === uid)?.status === 'waiting', 15000, 'waiting');
  const r = await ahCli('answer', uid, '1');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /answered: Yes/);
  await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('answered 1'), 8000, 'key typed');
});
