// A stand-in pi: a session file in pi's layout ($HOME/.pi/agent/sessions/--<cwd>--/<time>_<id>.jsonl)
// written when its first prompt comes, as pi does, under the id given with --session-id
// (else one of its own).
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const at = process.argv.indexOf('--session-id');
const id = at > 0 ? process.argv[at + 1] : randomUUID();
const dir = join(homedir(), '.pi', 'agent', 'sessions', `--${process.cwd().replace(/^\//, '').replace(/\//g, '-')}--`);
const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`);
const write = (o) => appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), ...o }) + '\n');

process.stdin.setRawMode(true);
console.log(`READY pi ${id}`);
let text = '';
let n = 0;
process.stdin.on('data', (chunk) => {
  for (const char of chunk.toString()) {
    if (char !== '\r' && char !== '\n') {
      text += char;
      continue;
    }
    const prompt = text;
    text = '';
    if (!n) {
      mkdirSync(dir, { recursive: true });
      write({ type: 'session', version: 3, id, cwd: process.cwd() });
    }
    write({ type: 'message', id: `u${++n}`, parentId: null, message: { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() } });
    write({ type: 'message', id: `a${n}`, parentId: `u${n}`, message: { role: 'assistant', content: [{ type: 'text', text: `Got ${prompt}` }], timestamp: Date.now() } });
    console.log(`RECEIVED:${prompt}`);
  }
});
