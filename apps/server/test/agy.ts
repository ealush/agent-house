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

/** Trajectory metadata: the conversation's folder and when it started. */
export function agyMetaBlob(cwd: string, at: number): string {
  return b64([...bytes(1, bytes(1, `file://${cwd}`)), ...stamp(2, at), ...bytes(7, `file://${cwd}`)]);
}
