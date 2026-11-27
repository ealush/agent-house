#!/usr/bin/env node
// A stand-in for Muse, as far as resuming and forking need one. It keeps sessions where Muse
// does (XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<id>/session.jsonl, every line an envelope with
// stream.id, a runtime.session.metadata record naming the workspace) and takes each line typed
// into it as a prompt, answered "Got: <it>".
//
// `muse resume <id>` opens that session. One Muse made itself (its index file is beside the
// log) goes on under its own id. One it didn't (ah's fork: a copy of the log alone) is what
// Muse 1.4 "recovers": it reads the log and starts a session of its own, with a new id, in the
// current directory. ah follows that one (server/fork.ts FORK_OPENS_ANEW).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = join(process.env.XDG_DATA_HOME, 'muse', 'sessions');
const args = process.argv.slice(2);
const cwd = process.cwd();
const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);

const r = args.indexOf('resume');
const wanted = r >= 0 && args[r + 1] && !args[r + 1].startsWith('--') ? args[r + 1] : null;
const given = wanted ? walk(root).find((f) => f.endsWith(`/${wanted}/session.jsonl`)) : undefined;
const own = given && existsSync(join(dirname(given), 'session.peer-history.index'));

let id;
let file;
let seq = 0;
if (own) {
  id = wanted;
  file = given;
  seq = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
} else {
  id = randomUUID();
  const d = new Date();
  const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'), id);
  mkdirSync(dir, { recursive: true });
  file = join(dir, 'session.jsonl');
  writeFileSync(join(dir, 'session.peer-history.index'), '');
}
const line = (payload_type, payload) => {
  seq++;
  appendFileSync(file, JSON.stringify({ schema_version: 1, id: `e${seq}`, stream: { kind: 'session', id }, sequence: seq, recorded_at: Date.now() * 1000, payload_type, payload }) + '\n');
};
if (!own) {
  line('runtime.session.metadata', { record: { workspace_root: cwd } });
  // Recovered: the conversation in the log it was given, re-recorded as this session's.
  if (given) {
    for (const l of readFileSync(given, 'utf8').split('\n')) {
      try {
        const d = JSON.parse(l);
        if (d?.payload_type === 'runtime.session') line('runtime.session', d.payload);
      } catch {}
    }
  }
}

process.stdin.setRawMode(true);
console.log(`READY muse ${id}${given && !own ? ` recovered ${wanted}` : ''}`);
let text = '';
process.stdin.on('data', (chunk) => {
  for (const char of chunk.toString()) {
    if (char !== '\r' && char !== '\n') {
      text += char;
      continue;
    }
    const prompt = text;
    text = '';
    if (!prompt.trim()) continue;
    console.log(`RECEIVED:${prompt}`);
    line('runtime.session', { kind: 'run', event: { kind: 'started', prompt } });
    line('runtime.session', { kind: 'run', event: { kind: 'assistant_message_committed', text: `Got: ${prompt.split('\n')[0]}` } });
  }
});
