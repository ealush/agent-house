import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLaunch, splitArgs, LaunchError } from './launch.ts';
import { loadConfig } from './config.ts';

const presets = loadConfig().presets;
const claude = presets.find((p) => p.id === 'claude')!;
const codex = presets.find((p) => p.id === 'codex')!;
const muse = presets.find((p) => p.id === 'muse')!;
const shell = presets.find((p) => p.id === 'shell')!;

test('claude default', () => {
  const p = buildLaunch(claude);
  assert.equal(p.command, 'claude');
  assert.deepEqual(p.args, []);
  assert.equal(p.summary, null);
});

test('claude dangerous mode', () => {
  const p = buildLaunch(claude, { mode: 'dangerous' });
  assert.equal(p.command, 'claude --dangerously-skip-permissions');
  assert.equal(p.meta['ah.launch.mode'], 'dangerous');
  assert.equal(p.summary, 'Skip permissions');
});

test('claude model selection', () => {
  const p = buildLaunch(claude, { model: 'sonnet' });
  assert.equal(p.command, 'claude --model sonnet');
  assert.equal(p.meta['ah.launch.model'], 'sonnet');
});

test('claude dangerous + model', () => {
  const p = buildLaunch(claude, { mode: 'dangerous', model: 'opus' });
  assert.equal(p.command, 'claude --dangerously-skip-permissions --model opus');
  assert.equal(p.summary, 'Opus 5.5 · Skip permissions');
});

test('claude resume preserves flags', () => {
  const p = buildLaunch(claude, { mode: 'dangerous', model: 'opus', resume: 'abc123' });
  assert.ok(p.command.startsWith('claude --resume abc123'));
  assert.ok(p.command.includes('--dangerously-skip-permissions') && p.command.includes('--model opus'));
});

test('muse default / yolo / model', () => {
  assert.equal(buildLaunch(muse).command, 'muse');
  assert.ok(buildLaunch(muse, { mode: 'yolo' }).command.includes('--yolo'));
  assert.ok(buildLaunch(muse, { mode: 'yolo' }).command.includes('--approval-mode never'), 'yolo states approval never explicitly');
  assert.ok(buildLaunch(muse, { model: 'spark' }).command.includes('--model spark'));
});

test('codex default and yolo', () => {
  assert.equal(buildLaunch(codex).command, 'codex');
  assert.ok(buildLaunch(codex, { mode: 'yolo' }).command.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('shell default and explicit shells', () => {
  assert.equal(buildLaunch(shell).command, '');
  assert.equal(buildLaunch(shell, { mode: 'bash' }).command, 'bash -i');
  assert.equal(buildLaunch(shell, { mode: 'zsh' }).command, 'zsh -i');
  assert.equal(buildLaunch(shell, { mode: 'fish' }).command, 'fish -i');
});

test('custom args appended and quoted', () => {
  const p = buildLaunch(claude, { extraArgs: '--foo --bar baz' });
  assert.ok(p.command.includes('--foo') && p.command.includes('--bar'));
  const q = buildLaunch(claude, { extraArgs: ['--model', 'a b'] });
  assert.ok(q.command.includes(`'a b'`), q.command);
});

test('invalid args rejected', () => {
  assert.throws(() => buildLaunch(claude, { extraArgs: 'a; rm -rf ~' }), LaunchError);
  assert.throws(() => buildLaunch(claude, { extraArgs: '$(evil)' }), LaunchError);
  assert.throws(() => buildLaunch(claude, { extraArgs: '`evil`' }), LaunchError);
  assert.throws(() => buildLaunch(claude, { extraArgs: 'a|b' }), LaunchError);
  assert.throws(() => buildLaunch(claude, { mode: 'nope' }), LaunchError);
  assert.throws(() => buildLaunch(claude, { model: 'bad model; evil' }), LaunchError);
});

test('appliesTo lets resume drop launch-only flags', () => {
  const p = { ...claude, modes: [{ id: 'x', name: 'X', args: ['--x'], appliesTo: 'launch' as const }] };
  assert.ok(buildLaunch(p, { mode: 'x' }).command.includes('--x'));
  assert.ok(!buildLaunch(p, { mode: 'x', resume: true }).command.includes('--x'));
});

test('splitArgs handles quotes', () => {
  assert.deepEqual(splitArgs('--a "b c" \'d e\''), ['--a', 'b c', 'd e']);
  assert.throws(() => splitArgs('--a "oops'), LaunchError);
  assert.deepEqual(splitArgs('--config="a b" a\\ b "it\'s okay"'), ['--config=a b', 'a b', "it's okay"]);
  assert.throws(() => splitArgs('unfinished\\'), LaunchError);
});

test('shell choices fail closed and custom resume executables are preserved', () => {
  assert.throws(() => buildLaunch(shell, { mode: 'unknown' }), LaunchError);
  const preset = { id: 'custom', name: 'Custom', command: 'agent', resumeId: 'wrapper --resume {id}' };
  assert.equal(buildLaunch(preset, { resume: 'thread' }).command, 'wrapper --resume thread');
  assert.equal(buildLaunch({ ...preset, command: '"/some path/agent" --config="a b"' }).command, "'/some path/agent' '--config=a b'");
});


test('model version, effort, and permissions become launch flags and survive resume', () => {
  const choice = { model: 'muse-spark-1.3-contributor', effort: 'ultra', mode: 'yolo' };
  for (const resume of [undefined, true] as const) {
    const plan = buildLaunch(muse, { ...choice, resume });
    assert.ok(plan.command.includes('--model muse-spark-1.3-contributor'));
    assert.ok(plan.command.includes('--reasoning-effort ultra'));
    assert.ok(plan.command.includes('--yolo'));
    assert.ok(plan.command.includes('--approval-mode never'), 'explicit approval-never survives resume');
    assert.equal(plan.meta['ah.launch.model'], choice.model);
    assert.equal(plan.meta['ah.launch.effort'], choice.effort);
  }
  assert.throws(() => buildLaunch(muse, { effort: 'unsupported' }), LaunchError);
  assert.throws(() => buildLaunch(shell, { extraArgs: '$(evil)' }), LaunchError);
});

test('effort validation respects the default model and an explicitly empty supported list', () => {
  const preset = { ...codex, models: [
    { id: 'light', name: 'Light', args: ['--model', 'light'], efforts: [], isDefault: true },
    { id: 'deep', name: 'Deep', args: ['--model', 'deep'], efforts: ['high'] },
  ] };
  assert.throws(() => buildLaunch(preset, { effort: 'high' }), LaunchError);
  assert.throws(() => buildLaunch(preset, { model: 'light', effort: 'high' }), LaunchError);
  assert.throws(() => buildLaunch(preset, { model: 'deep', effort: 'low' }), LaunchError);
  assert.ok(buildLaunch(preset, { model: 'deep', effort: 'high' }).command.includes('model_reasoning_effort=high'));
});
