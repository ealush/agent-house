#!/usr/bin/env node
// node-pty starts every terminal through a small helper binary (spawn-helper). Its prebuilt
// macOS copies (prebuilds/darwin-*) arrive from the package without the execute bit, and
// then every terminal attach on a Mac host fails with "posix_spawnp failed". Run after
// install (package.json postinstall): gives each helper its execute bit back, and says so.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const pty = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
const prebuilds = join(pty, 'prebuilds');
const helpers = [
  join(pty, 'build', 'Release', 'spawn-helper'),
  ...(existsSync(prebuilds) ? readdirSync(prebuilds).map((platform) => join(prebuilds, platform, 'spawn-helper')) : []),
].filter((p) => existsSync(p));
for (const helper of helpers) {
  const { mode } = statSync(helper);
  if ((mode & 0o111) === 0o111) continue;
  chmodSync(helper, mode | 0o111);
  console.log(`node-pty: made ${helper.slice(pty.length + 1)} executable`);
}
