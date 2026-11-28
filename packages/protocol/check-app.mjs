#!/usr/bin/env node
// The app's side of the contract, read from its sources (no Swift needed, so it runs on any
// machine and in every server CI job): the API version the app accepts is the server's, and
// every feature the app gates on (`supports("name", version: n)`) is one the server
// announces, at that version or later (versions.json, kept by apps/server/test/protocol.test.ts).
// And `AppProtocol.requires` (apps/ios/Sources/Networking/AppProtocol.swift), what this app
// tells a host it needs and what it calls a host behind it, is exactly those gates.
//
//   node packages/protocol/check-app.mjs           (mise run protocol:check)
//   node packages/protocol/check-app.mjs --write   (rewrite AppProtocol.requires from the gates)
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

// AppProtocol.requires, between its markers: one `"name": version,` line per gate, by name.
const protocolFile = join(sources, 'Networking/AppProtocol.swift');
const appProtocol = readFileSync(protocolFile, 'utf8');
const block = /(\/\/ BEGIN requires \(check-app\.mjs --write\)\n)([\s\S]*?)( *\/\/ END requires)/;
const indent = appProtocol.match(/\n( *)\/\/ BEGIN requires/)?.[1] ?? '        ';
const wanted = [...gates.keys()].sort().map((name) => `${indent}"${name}": ${gates.get(name).version},\n`).join('');
const found = appProtocol.match(block);
if (!found) problems.push(`${relative(repo, protocolFile)} has no "// BEGIN requires" … "// END requires" block: update this check`);
else if (found[2] !== wanted) {
  if (process.argv.includes('--write')) {
    writeFileSync(protocolFile, appProtocol.replace(block, (_, begin, _old, end) => `${begin}${wanted}${end}`));
    console.log(`protocol: rewrote AppProtocol.requires from the app's ${gates.size} feature gates`);
  } else {
    const listed = new Map([...found[2].matchAll(/"(\w+)": (\d+)/g)].map((m) => [m[1], Number(m[2])]));
    const differ = [...new Set([...listed.keys(), ...gates.keys()])].sort().filter((n) => listed.get(n) !== gates.get(n)?.version);
    problems.push(`AppProtocol.requires isn't the app's feature gates (${differ.map((n) => `${n}: listed ${listed.get(n) ?? '—'}, gated ${gates.get(n)?.version ?? '—'}`).join('; ')}): run node packages/protocol/check-app.mjs --write`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL: ${p}`);
  process.exit(1);
}
console.log(`protocol: the app accepts API ${accepted} (the server's); its ${gates.size} feature gates (${[...gates.keys()].sort().join(', ')}) are all announced at their versions, and are AppProtocol.requires`);
