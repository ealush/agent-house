// Antigravity CLI (agy) conversations for tests: the real one in
// server/fixtures/agy/conversation.json (agy 1.5.14, trimmed to the fields ah reads,
// its folder renamed /home/me/proj), or steps made here, written the way agy keeps
// them: <dir>/<conversation id>.db, a `steps` table of protobuf payloads and the
// trajectory metadata (server/feed/adapters/agy.ts has the field numbers).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type AgyStep = { idx: number; type: number; status: number; payload: string };
export type AgyConversation = { id: string; meta: string; steps: AgyStep[] };

export const agyFixture: AgyConversation = JSON.parse(readFileSync(new URL('../server/fixtures/agy/conversation.json', import.meta.url), 'utf8'));

export function writeAgyConversation(dir: string, conv: AgyConversation = agyFixture, steps: AgyStep[] = conv.steps): string {
  const file = join(dir, `${conv.id}.db`);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, step_payload blob);
           CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main" PRIMARY KEY, data blob);`);
  const put = db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)');
  for (const s of steps) put.run(s.idx, s.type, s.status, Buffer.from(s.payload, 'base64'));
  db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', Buffer.from(conv.meta, 'base64'));
  db.close();
  return file;
}

// ---------- a few steps made by hand

const varint = (n: number): number[] => {
  const out: number[] = [];
  do {
    let c = n % 128;
    n = Math.floor(n / 128);
    if (n) c |= 0x80;
    out.push(c);
  } while (n);
  return out;
};
const int = (field: number, n: number) => [...varint(field * 8), ...varint(n)];
const bytes = (field: number, b: number[] | string) => {
  const body = typeof b === 'string' ? [...Buffer.from(b, 'utf8')] : b;
  return [...varint(field * 8 + 2), ...varint(body.length), ...body];
};
const stamp = (field: number, ms: number) => bytes(field, [...int(1, Math.floor(ms / 1000)), ...int(2, (ms % 1000) * 1e6)]);
const b64 = (b: number[]) => Buffer.from(b).toString('base64');

/** Something you typed (USER_INPUT, DONE), at `at`. */
export function agyUserStep(idx: number, text: string, at: number): AgyStep {
  return { idx, type: 14, status: 3, payload: b64([...int(1, 14), ...int(4, 3), ...bytes(5, stamp(1, at)), ...bytes(19, [...bytes(2, text), ...bytes(3, bytes(1, text))])]) };
}

/** Its reply (PLANNER_RESPONSE, DONE). */
export function agyReplyStep(idx: number, text: string, at: number): AgyStep {
  return { idx, type: 15, status: 3, payload: b64([...int(1, 15), ...int(4, 3), ...bytes(5, stamp(1, at)), ...bytes(20, [...bytes(1, text), ...bytes(8, text)])]) };
}

/** What agy showed you in red (ERROR_MESSAGE, DONE): `shown` false is one it kept from you. */
export function agyErrorStep(idx: number, text: string, at: number, shown = true): AgyStep {
  const error = [...bytes(3, [...bytes(1, text), ...bytes(2, text.slice(0, 40))]), ...(shown ? int(5, 1) : [])];
  return { idx, type: 17, status: 3, payload: b64([...int(1, 17), ...int(4, 3), ...bytes(5, stamp(1, at)), ...bytes(24, error)]) };
}

/** Trajectory metadata: the conversation's folder and when it started. */
export function agyMetaBlob(cwd: string, at: number): string {
  return b64([...bytes(1, bytes(1, `file://${cwd}`)), ...stamp(2, at), ...bytes(7, `file://${cwd}`)]);
}

// The same prompt in a window a phone narrowed to 49 columns (agy 1.5.15): its rows wrap
// back to the first column, a long path at its "-", well short of the edge.
export const AGY_COMMAND_NARROW: string[] = `
whether those files have uncommitted local
changes that would be lost.
Requesting permission for:...

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation
for commands that start with 'rsync -az
/home/mine/code/.worktrees/agent-
house/gemini-8fae/apps/ios/Sources/...'
  3. Yes, and always allow for commands that
start with 'rsync -az
/home/mine/code/.worktrees/agent-
house/gemini-8fae/apps/ios/Sources/...'
(Persist to settings.json)
  4. No, cancel

  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand c
esc to cancel         auto · Gemini 4 Neon · high`.split('\n');

// Out of quota at a phone's 49 columns (agy 1.5.15): the notice, then the empty prompt box.
export const AGY_QUOTA_NARROW: string[] = `
  And linking them in chat should expand it to
  session reference

⚠ Individual quota reached. Please upgrade your
subscription to increase your limits. Resets in
1h8m36s.
Error ID: 00000000-0000-0000-0000-000000000000-
1801

─────────────────────────────────────────────────
> Anyway, build review, get the ui right and
  land

⚠ Individual quota reached. Please upgrade your
subscription to increase your limits. Resets in
1h7m49s.
Error ID: 00000000-0000-0000-0000-000000000000-
1803

─────────────────────────────────────────────────
>
─────────────────────────────────────────────────
? for shortcuts       auto · Gemini 4 Neon · high`.split('\n');

// Another command prompt at 49 columns (agy 1.5.15): agy wraps its rows a few columns short
// of the window, so "'node_modules'" went on to the next line though it would have fit.
export const AGY_RSYNC_NARROW: string[] = `
● Ran 5 commands (+4 · git status)
Reason: The command runs rsync with
--delete to a remote host
(mine@100.64.0.1:~/code/ah-space-porta
l/),
which can overwrite and permanently delete
files on that remote machine.
Requesting permission for:...

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation
for commands that start with 'rsync -az --
delete --exclude '.git' --exclude
'node_modules' --exclude 'DerivedD...'
  3. Yes, and always allow for commands that
start with 'rsync -az --delete --exclude '.git'
--exclude 'node_modules' --exclude
'DerivedD...' (Persist to settings.json)
  4. No, cancel

  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand c
esc to cancel         auto · Gemini 4 Neon · high`.split('\n');

/** A command it asked you about first (a tool step): DONE with its output, CANCELED without, or RUNNING with none yet. */
export function agyAskedCommandStep(idx: number, callId: string, command: string, why: string, at: number, outcome: 'ran' | 'stopped' | 'running' = 'ran'): AgyStep {
  const call = [...bytes(1, callId), ...bytes(2, 'run_command'), ...bytes(3, JSON.stringify({ CommandLine: command }))];
  const meta = [...stamp(1, at), ...bytes(4, call), ...bytes(34, [...bytes(4, 'ask'), ...bytes(5, why)])];
  const run = outcome === 'ran' ? bytes(140, bytes(2, bytes(1, 'Created At: 2026-11-24T08:37:41+02:00\nCommand exited with code 0.'))) : [];
  const status = { ran: 3, stopped: 6, running: 2 }[outcome];
  return { idx, type: 132, status, payload: b64([...int(1, 132), ...int(4, status), ...bytes(5, meta), ...run]) };
}
