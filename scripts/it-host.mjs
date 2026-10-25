#!/usr/bin/env node
// A disposable ah host for the native client's integration tests: isolated state, its own
// tmux server, and fake agents from ah's own test fixtures. Never a real agent or secret.
//
//   AH_SOURCE=../ah node scripts/it-host.mjs
//
// Prints one JSON line {port, localToken, dir} once ah listens, then keeps it running
// until stdin closes (or SIGTERM), and cleans everything up.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = resolve(process.env.AH_SOURCE ?? new URL('../../ah', import.meta.url).pathname);
const { startAh, cleanup } = await import(pathToFileURL(join(source, 'test/helpers.ts')).href);
const fixture = (name) => join(source, 'test/fixtures', name);
const node = process.execPath;
const dir = mkdtempSync(join(tmpdir(), 'ah-native-it-'));
const keys = join(dir, 'picker-keys.log');
// Each fixture runs node under its own name, so ah tells them apart by process (comm).
const bin = join(dir, 'bin');
mkdirSync(bin, { recursive: true });
const runner = (name) => {
  symlinkSync(node, join(bin, name));
  return join(bin, name);
};
// Host tools Settings → System reaches, kept inside this host: Omarchy's web-app installer
// would add a launcher to this machine's real desktop, and restart/rebuild would restart
// this machine's own ah. The stand-ins write the launcher into this host's XDG_DATA_HOME.
const tool = (name, script) => writeFileSync(join(bin, name), `#!/bin/sh\n# Stand-in for ${name}: this test host's own data folder only.\n${script}\n`, { mode: 0o755 });
tool('omarchy-webapp-install', 'mkdir -p "$XDG_DATA_HOME/applications" && printf "[Desktop Entry]\\nName=%s\\nExec=xdg-open %s\\n" "$1" "$2" > "$XDG_DATA_HOME/applications/$1.desktop"');
tool('omarchy-webapp-remove', 'rm -f "$XDG_DATA_HOME/applications/$1.desktop"');
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.AH_RESTART_CMD = 'true';
process.env.AH_REBUILD_CMD = 'sleep 1';
const agentNode = runner('ahit-agent');
const claudeNode = runner('ahit-claude');
const pickerNode = runner('ahit-picker');

const ah = await startAh({
  idleAfter: 1,
  presets: [
    { id: 'shell', name: 'Shell', command: '' },
    // Busy for a while after each prompt, then done; Esc interrupts.
    { id: 'test-agent', name: 'Test agent', command: `exec ${agentNode} ${fixture('agent.js')} --turn=2500`, match: '^ahit-agent$' },
    // Writes a Claude-shaped transcript: user turn, Bash tool call + result, prose, a widget.
    { id: 'claude', name: 'Fixture', command: `exec ${claudeNode} ${fixture('transcript-agent.js')}`, match: '^ahit-claude$', feed: 'claude' },
    // A permission prompt Approve/Deny can answer.
    { id: 'test-claude', name: 'Picker', command: `exec ${pickerNode} ${fixture('picker.js')} permission ${keys}`, match: '^ahit-picker$', waitingPatterns: ['Do you want to proceed'], approveKeys: ['Enter'], denyKeys: ['Escape'] },
  ],
}, dir);

process.stdout.write(JSON.stringify({ port: ah.port, localToken: ah.localToken(), dir: ah.dir, keys }) + '\n');
// ah's own log goes to stderr, which scripts/integration.sh can keep (AH_IT_LOG).
setInterval(() => {
  const log = ah.log();
  if (log.length > written) {
    process.stderr.write(log.slice(written));
    written = log.length;
  }
}, 200).unref();
let written = 0;

let done = false;
const stop = async () => {
  if (done) return;
  done = true;
  await cleanup(ah).catch(() => {});
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.resume();
