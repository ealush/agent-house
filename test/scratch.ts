// A test file's own temporary directory. Imported first, for its effect: everything the
// file makes with os.tmpdir() — databases, repositories, worktrees beside them, the
// servers it starts — lands in one directory, removed when the file's tests end. Unit
// tests used to leave a database or a folder in /tmp per test, per run (11,000 of them
// on a busy day), filling a tmpfs other runs share.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ah-unit-'));
process.env.TMPDIR = dir;
// Removed when the process exits — after every test and every one of the file's own
// `after` hooks. Never earlier: a hook that cleans up after the tests (a tmux server's
// `kill-server` under a TMUX_TMPDIR in here) must still find its directory, or tmux falls
// back to the default socket, the developer's real server.
process.on('exit', () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
