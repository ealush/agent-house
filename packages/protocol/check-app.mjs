#!/usr/bin/env node
// The app's side of the contract, read from its sources (no Swift needed, so it runs on any
// machine and in every server CI job): the API version the app accepts is the server's, and
// every feature the app gates on (`supports("name", version: n)`) is one the server
// announces, at that version or later (versions.json, kept by apps/server/test/protocol.test.ts).
//
//   node packages/protocol/check-app.mjs      (mise run protocol:check)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const versions = JSON.parse(readFileSync(new URL('./versions.json', import.meta.url), 'utf8'));
const sources = join(repo, 'apps/ios/Sources');
const problems = [];

const dto = readFileSync(join(sources, 'Networking/HubStateDTO.swift'), 'utf8');
const accepted = Number(dto.match(/static let supportedAPIVersion = (\d+)/)?.[1]);
if (!accepted) problems.push('HubStateDTO.supportedAPIVersion not found: update this check');
else if (accepted !== versions.api) problems.push(`the app accepts API ${accepted}, the server sends ${versions.api}: installed apps refuse a host whose API differs`);

const swift = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.swift')) swift.push(p);
  }
};
walk(sources);
const gates = new Map();
for (const file of swift) {
  for (const m of readFileSync(file, 'utf8').matchAll(/supports\("(\w+)"(?:,\s*version:\s*(\d+))?\)/g)) {
    const [name, version] = [m[1], Number(m[2] ?? 1)];
    if ((gates.get(name)?.version ?? 0) < version) gates.set(name, { version, file: relative(repo, file) });
  }
}
for (const [name, { version, file }] of gates) {
  const has = versions.features[name];
  if (has === undefined) problems.push(`${file} gates on feature "${name}", which the server doesn't announce`);
  else if (has < version) problems.push(`${file} needs "${name}" ${version}; the server announces ${has}`);
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL: ${p}`);
  process.exit(1);
}
console.log(`protocol: the app accepts API ${accepted} (the server's); its ${gates.size} feature gates (${[...gates.keys()].sort().join(', ')}) are all announced at their versions`);
