import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Preset } from './config.ts';
import { Harnesses, adjust, choiceName, choicesIn, describeChanges, flagBlock, modeFlag } from './harnesses.ts';

const presets = loadConfig().presets;
const byId = (id: string) => structuredClone(presets.find((p) => p.id === id)!);

// Shapes of --help the agent CLIs print (commander, clap, yargs, argparse, prose).
const COMMANDER = `Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts
`;
const CLAP = `      --permission-mode <MODE>
          Permission mode

          [possible values: default, acceptEdits, auto, dontAsk, bypassPermissions, plan]

      --prompt-file <PATH>
          Single-turn prompt from a file
`;
const YARGS = `      --approval-mode             Set the approval mode: default (prompt for approval), auto_edit (auto-approve edit tools)  [string] [choices: "default", "auto_edit", "yolo", "plan"]
      --policy                    Additional policy files
`;
const ARGPARSE = `  --reasoning LEVEL     Reasoning effort for this invocation: none, minimal,
                        low, medium, high, xhigh, max, or ultra. Overrides
                        agent.reasoning_effort in config.yaml for this run
  -t TOOLSETS, --toolsets TOOLSETS
`;
const PIPES = `      --reasoning-effort <EFFORT>
          Meta reasoning effort: none|minimal|low|medium|high|xhigh|max|ultra
          (default: high; alias: --effort)
      --base-url <URL>
`;
const PROSE = `  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh, max
  --extension, -e <path>         Load an extension file
`;

test('reads the choices a flag lists, in every --help shape', () => {
  assert.deepEqual(choicesIn(flagBlock(COMMANDER, '--permission-mode')!), ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
  assert.deepEqual(choicesIn(flagBlock(COMMANDER, '--effort')!), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(choicesIn(flagBlock(CLAP, '--permission-mode')!), ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan']);
  assert.deepEqual(choicesIn(flagBlock(YARGS, '--approval-mode')!), ['default', 'auto_edit', 'yolo', 'plan']);
  assert.deepEqual(choicesIn(flagBlock(ARGPARSE, '--reasoning')!), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(choicesIn(flagBlock(PIPES, '--reasoning-effort')!), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(choicesIn(flagBlock(PROSE, '--thinking')!), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('a block ends at the next option, and prose is not a list', () => {
  assert.equal(flagBlock(COMMANDER, '--permission-prompts')?.includes('acceptEdits'), false);
  assert.equal(choicesIn('--model <model>   Model for the current session. Provide an alias for the latest model'), null);
  assert.equal(flagBlock(COMMANDER, '--nope'), null);
});

test("a CLI's new permission modes appear, named, and its dropped ones go", () => {
  const claude = byId('claude');
  assert.equal(modeFlag(claude), '--permission-mode');
  const out = adjust(claude, { version: '9', checkedAt: 0, changes: [], modeChoices: ['acceptEdits', 'manual', 'dontAsk', 'plan', 'bypassPermissions'] });
  const ids = out.modes!.map((m) => m.id);
  // "auto" left the list; "manual" is the CLI's default (Ask already stands for it);
  // bypassPermissions is a second way to skip approvals, so it isn't offered twice.
  assert.ok(!ids.includes('auto'));
  assert.ok(ids.includes('dont-ask') && !ids.includes('manual') && !ids.includes('bypass-permissions'));
  assert.deepEqual(out.modes!.find((m) => m.id === 'dont-ask')!.args, ['--permission-mode', 'dontAsk']);
  assert.equal(out.modes!.find((m) => m.id === 'dont-ask')!.name, "Don't ask");
  // The ones it knew keep their names and descriptions.
  assert.equal(out.modes!.find((m) => m.id === 'plan')!.description, claude.modes!.find((m) => m.id === 'plan')!.description);
  assert.deepEqual(describeChanges(claude, out), ["New mode: Don't ask", 'Mode gone: Auto']);
});

test('a risky new mode is marked dangerous when it is the only one', () => {
  const p: Preset = { id: 'x', name: 'X', command: 'x', modes: [{ id: 'default', name: 'Ask' }, { id: 'plan', name: 'Plan', args: ['--mode', 'plan'] }] };
  const out = adjust(p, { version: '1', checkedAt: 0, changes: [], modeChoices: ['plan', 'yolo'] });
  assert.equal(out.modes!.find((m) => m.id === 'yolo')!.dangerous, true);
});

test('effort levels follow the CLI, but only from a list of the same kind', () => {
  const grok = byId('grok');
  assert.deepEqual(adjust(grok, { version: '2', checkedAt: 0, changes: [], effortChoices: ['low', 'medium', 'high', 'xhigh', 'max'] }).effort!.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(adjust(grok, { version: '2', checkedAt: 0, changes: [], effortChoices: ['text', 'json', 'stream-json'] }).effort!.levels, grok.effort!.levels);
  assert.equal(adjust(grok, undefined), grok);
});

test('choice names read as words', () => {
  assert.equal(choiceName('dontAsk'), "Don't ask");
  assert.equal(choiceName('auto_edit'), 'Auto edit');
  assert.equal(choiceName('accept-edits'), 'Accept edits');
});

test('a CLI is read again only when its version changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-harness-'));
  const log = join(dir, 'calls');
  const version = join(dir, 'version');
  writeFileSync(version, '1.0.0');
  writeFileSync(log, '');
  // A stand-in CLI: prints its version, or a --help naming the modes it takes.
  const bin = join(dir, 'fakeagent');
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$1" >> ${log}\nif [ "$1" = --version ]; then cat ${version}; exit 0; fi\nif [ "$(cat ${version})" = 2.0.0 ]; then echo '  --mode <m>  Mode (choices: "plan", "turbo")'; else echo '  --mode <m>  Mode (choices: "plan", "careful")'; fi\n`,
  );
  chmodSync(bin, 0o755);
  const p: Preset = { id: 'fake', name: 'Fake', command: bin, modes: [{ id: 'default', name: 'Ask' }, { id: 'plan', name: 'Plan', args: ['--mode', 'plan'] }, { id: 'careful', name: 'Careful', args: ['--mode', 'careful'] }] };
  const h = new Harnesses(join(dir, 'harnesses.json'));
  await h.check([p], process.env, () => true);
  assert.equal(h.probe('fake')!.version, '1.0.0');
  assert.deepEqual(h.probe('fake')!.modeChoices, ['plan', 'careful']);
  // Same version, asked again (forced past the recheck interval): no second --help.
  await h.check([p], process.env, () => true, false);
  assert.equal(readFileSync(log, 'utf8').split('\n').filter((l) => l === '--help').length, 1);
  // A new version: read again, and what changed is said.
  writeFileSync(version, '2.0.0');
  await h.check([p], process.env, () => true, true);
  assert.deepEqual(h.probe('fake')!.changes, ['New mode: Turbo', 'Mode gone: Careful']);
  // It survives a restart.
  assert.equal(new Harnesses(join(dir, 'harnesses.json')).probe('fake')!.version, '2.0.0');
});

test('agents added by hand: named, one-line, unique, and removable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-harness-'));
  const h = new Harnesses(join(dir, 'harnesses.json'));
  const a = h.addCustom({ name: 'Aider', command: 'aider --no-auto-commits' }, ['claude']);
  assert.equal(a.id, 'custom-aider');
  assert.equal(h.addCustom({ name: 'Aider', command: 'aider' }, []).id, 'custom-aider-2');
  assert.throws(() => h.addCustom({ name: '', command: 'x' }, []));
  assert.throws(() => h.addCustom({ name: 'X', command: 'a\nrm -rf /' }, []));
  assert.equal(Harnesses.preset(a).command, 'aider --no-auto-commits');
  h.setHidden('custom-aider', true);
  assert.ok(h.removeCustom('custom-aider'));
  assert.equal(h.hidden('custom-aider'), false);
  assert.equal(new Harnesses(join(dir, 'harnesses.json')).custom().length, 1);
});
