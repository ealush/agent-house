#!/usr/bin/env node
// Sends lines to a demo session from outside the app, as another device would: each one is a
// message, and while the agent works they wait in its queue. With the demo agent's long turns
// (`/stream [n]`, `/long [n]`, scripts/demo/agent.mjs) this sets up what the layout tests need:
// a transcript streaming in, a long conversation, a queue of ten. Demo and test use only.
//
//   node scripts/demo/drive.mjs <demo state dir> "<session title>" <line>...
//   node scripts/demo/drive.mjs <dir> "Users latency" "/stream 120" --queue 12
//
// `--queue <n>` adds n numbered follow-ups after the lines, so they queue behind them.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [dirArg, title, ...rest] = process.argv.slice(2);
if (!dirArg || !title) throw new Error('usage: drive.mjs <dir> "<session title>" <line>... [--queue <n>]');
const lines = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--queue') {
    const n = Number(rest[++i]);
    for (let k = 1; k <= n; k++) lines.push(`Queued follow-up ${k} of ${n}: check the users cache again after this.`);
  } else lines.push(rest[i]);
}
const { port, localToken } = JSON.parse(readFileSync(join(resolve(dirArg), 'demo.json'), 'utf8'));
const headers = { Authorization: `Bearer ${localToken}`, 'X-AH': '1', Origin: `http://localhost:${port}`, 'Content-Type': 'application/json' };
const call = async (method, path, body) => {
  const res = await fetch(`http://localhost:${port}${path}`, { method, headers, body: body && JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
};
const state = await call('GET', '/api/state');
const window = state.windows.find((w) => w.title === title);
if (!window) throw new Error(`no live session titled ${title}`);
for (const text of lines) {
  const out = await call('POST', `/api/sessions/${window.uid}/send`, { text });
  process.stdout.write(`${out.outcome}${out.queued ? ` (${out.queued} queued)` : ''}: ${text.slice(0, 60)}\n`);
  // The first line starts a turn: the rest should find it working, and queue.
  if (text === lines[0]) await new Promise((r) => setTimeout(r, 1500));
}
