// A test file's own temporary directory. Imported first, for its effect: everything the
// file makes with os.tmpdir() — databases, repositories, worktrees beside them, the
// servers it starts — lands in one directory, removed when the file's tests end. Unit
// tests used to leave a database or a folder in /tmp per test, per run (11,000 of them
// on a busy day), filling a tmpfs other runs share.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ah-unit-'));
process.env.TMPDIR = dir;
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
