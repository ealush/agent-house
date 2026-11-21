#!/usr/bin/env node
// A disposable ah host for the native client's integration tests: isolated state, its own
// tmux server, and fake agents from ah's own test fixtures. Never a real agent or secret.
//
//   node scripts/it-host.mjs              # this repository's server (AH_SOURCE=<checkout> for another)
//
// Prints one JSON line {port, localToken, dir} once ah listens, then keeps it running
// until stdin closes (or SIGTERM), and cleans everything up.
import { pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serverRoot } from './server-root.mjs';

const source = serverRoot();
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
// Their own folder on PATH: the agents' runners in bin stay off it.
const tools = join(dir, 'tools');
mkdirSync(tools, { recursive: true });
const tool = (name, script) => writeFileSync(join(tools, name), `#!/bin/sh\n# Stand-in for ${name}: this test host's own data folder only.\n${script}\n`, { mode: 0o755 });
tool('omarchy-webapp-install', 'mkdir -p "$XDG_DATA_HOME/applications" && printf "[Desktop Entry]\\nName=%s\\nExec=xdg-open %s\\n" "$1" "$2" > "$XDG_DATA_HOME/applications/$1.desktop"');
tool('omarchy-webapp-remove', 'rm -f "$XDG_DATA_HOME/applications/$1.desktop"');
process.env.PATH = `${tools}:${process.env.PATH}`;
process.env.AH_RESTART_CMD = 'true';
process.env.AH_REBUILD_CMD = 'sleep 1';
const agentNode = runner('ahit-agent');
const claudeNode = runner('ahit-claude');
const pickerNode = runner('ahit-picker');
const questionNode = runner('ahit-question');
const demoNode = runner('ahit-demo');
// The question dialog logs every key it gets here (tests run one at a time and clear it).
const questionKeys = join(dir, 'question-keys.log');
const demoAgent = new URL('./demo/agent.mjs', import.meta.url).pathname;
// Claude Code's own screen rules, so ah reads these stand-ins' pickers as it reads Claude's.
const claudeRules = ['Do you want to (proceed|make this edit|create|allow)', '^\\s*❯\\s*1\\.\\s*Yes', 'Enter to select · .*to navigate', 'trust this folder|Enter to confirm · Esc to cancel'];

const ah = await startAh({
  idleAfter: 1,
  presets: [
    { id: 'shell', name: 'Shell', command: '' },
    // Busy for a while after each prompt, then done; Esc interrupts.
    { id: 'test-agent', name: 'Test agent', command: `exec ${agentNode} ${fixture('agent.js')} --turn=2500`, match: '^ahit-agent$' },
    // Writes a Claude-shaped transcript: user turn, Bash tool call + result, prose, a widget.
    // Resumable (fork, relaunch), with launch choices: models and permission modes relaunch,
    // effort switches live by typing its command.
    {
      id: 'claude', name: 'Fixture', command: `exec ${claudeNode} ${fixture('transcript-agent.js')}`, match: '^ahit-claude$', feed: 'claude',
      resume: `exec ${claudeNode} ${fixture('transcript-agent.js')}`, resumeId: `exec ${claudeNode} ${fixture('transcript-agent.js')} --resume {id}`,
      models: [{ id: 'fast', name: 'Fast', args: ['--model', 'fast'] }, { id: 'deep', name: 'Deep', args: ['--model', 'deep'] }],
      effort: { args: ['--effort', '{level}'], levels: ['low', 'medium', 'high'] },
      switchEffort: '/effort {level}',
      modes: [{ id: 'default', name: 'Ask first' }, { id: 'auto', name: 'Run anything', args: ['--auto'], dangerous: true }],
    },
    // A permission prompt Approve/Deny can answer.
    { id: 'test-claude', name: 'Picker', command: `exec ${pickerNode} ${fixture('picker.js')} permission ${keys}`, match: '^ahit-picker$', waitingPatterns: ['Do you want to proceed'], approveKeys: ['Enter'], denyKeys: ['Escape'] },
    // Claude's AskUserQuestion dialog (Color, then multi-select Toppings, then the review),
    // redrawn as keys arrive. Logs every key to question-keys.log.
    { id: 'ask-dialog', name: 'Questions', command: `exec ${questionNode} ${fixture('picker.js')} question ${questionKeys}`, match: '^ahit-question$', waitingPatterns: claudeRules, questions: 'claude' },
    // The demo's scripted Claude: /ask, /plan and /trust open Claude Code's own pickers,
    // and its transcript is Claude-shaped (the plan's ExitPlanMode call, the answers).
    { id: 'demo-claude', name: 'Demo agent', command: `exec ${demoNode} ${demoAgent} --scenario=none`, match: '^ahit-demo$', feed: 'claude', waitingPatterns: claudeRules, questions: 'claude' },
  ],
}, dir);

process.stdout.write(JSON.stringify({ port: ah.port, localToken: ah.localToken(), dir: ah.dir, keys, questionKeys }) + '\n');
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
