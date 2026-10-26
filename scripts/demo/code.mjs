#!/usr/bin/env node
// Prints a one-time setup code from a running demo host (scripts/demo/host.mjs), the way
// `ah auth code` does on a real host. Demo and test use only.
//
//   node scripts/demo/code.mjs <demo state dir>
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '.');
const { port, localToken } = JSON.parse(readFileSync(join(dir, 'demo.json'), 'utf8'));
const res = await fetch(`http://localhost:${port}/api/auth/code`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${localToken}`, 'X-AH': '1', Origin: `http://localhost:${port}`, 'Content-Type': 'application/json' },
  body: '{}',
});
if (!res.ok) throw new Error(`setup code: ${res.status} ${await res.text()}`);
process.stdout.write((await res.json()).code + '\n');
