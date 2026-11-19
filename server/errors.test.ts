import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError, errorReply } from './errors.ts';
import { HttpError } from './http.ts';
import { CoreError } from './core.ts';
import { GitError } from './git.ts';
import { LaunchError } from './launch.ts';
import { JobError } from './jobs/scheduler.ts';
import { NoteError } from './notes/store.ts';

test('a refusal keeps its status, message and code', () => {
  assert.deepEqual(errorReply(new JobError(409, 'busy_job', 'the job is running')), { status: 409, body: { error: 'the job is running', code: 'busy_job' }, close: false, internal: false });
  assert.deepEqual(errorReply(new CoreError(404, 'no such session')).body, { error: 'no such session' });
  assert.equal(errorReply(new HttpError(400, 'invalid json')).status, 400);
});

test('git and launch refusals are the caller’s mistake (400), not a crash', () => {
  assert.equal(errorReply(new GitError('invalid branch name: x y')).status, 400);
  assert.equal(errorReply(new LaunchError('unknown mode: z')).status, 400);
});

test('anything that is not a DomainError is a 500 that says nothing', () => {
  const r = errorReply(Object.assign(new Error('ENOENT: /home/me/secret'), { code: 'ENOENT', stderr: 'boom' }));
  assert.deepEqual(r, { status: 500, body: { error: 'internal error' }, close: false, internal: true });
  assert.equal(errorReply('a string').status, 500);
  assert.equal(errorReply(null).status, 500);
});

test('a command’s own complaint is the message when it has one', () => {
  const err = Object.assign(new GitError('Command failed: git switch'), { stderr: "  fatal: invalid reference: nope\n" });
  assert.equal(errorReply(err).body.error, 'fatal: invalid reference: nope');
  assert.equal(errorReply(Object.assign(new GitError('plain'), { stderr: '   ' })).body.error, 'plain');
});

test('a refused body (too large, no room) closes the connection', () => {
  assert.equal(errorReply(new HttpError(413, 'body too large')).close, true);
  assert.equal(errorReply(new HttpError(507, 'disk full', 'no_space')).close, true);
  assert.equal(errorReply(new HttpError(400, 'x')).close, false);
});

test('a note refusal is still a DomainError, with the note it carries', () => {
  const err = new NoteError(409, 'conflict', 'changed elsewhere');
  assert.ok(err instanceof DomainError);
  assert.equal(err.code, 'conflict');
});

// The rule, checked: a domain's refusals reach the edge as DomainErrors, so no route
// needs to know any domain's error class to answer with the right status.
test('every exported error class a request can meet extends DomainError', async () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  // Internal to their module: always caught and rethrown as that domain's own error.
  const internal = new Set(['DomainError', 'PasteError', 'ManifestError', 'CronError', 'GhError', 'MaybeArrived']);
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'fixtures' ? [] : files(join(dir, e.name))) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : []));
  const offenders: string[] = [];
  for (const file of files(root)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/^export class (\w+Error) extends (\w+)/gm)) {
      if (internal.has(m[1])) continue;
      const mod = await import(file);
      if (!(mod[m[1]].prototype instanceof DomainError)) offenders.push(`${relative(root, file)}: ${m[1]} extends ${m[2]}`);
    }
  }
  assert.deepEqual(offenders, []);
});
