import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLaunch, splitArgs, permissionLevelOf, resolvePermissionMode, resumesConversation, LaunchError } from './launch.ts';
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

test('hot swap: resume keeps the conversation id and applies the new model/effort', () => {
  const swap = buildLaunch(codex, { model: 'gpt-6-sol', resume: 'rid123' });
  assert.ok(swap.command.startsWith('codex resume rid123'), swap.command);
  assert.ok(swap.command.includes('--model gpt-6-sol'), swap.command);
  assert.equal(swap.meta['ah.launch.model'], 'gpt-6-sol');
  const effort = buildLaunch(codex, { effort: 'high', resume: 'rid123' });
  assert.ok(effort.command.includes('model_reasoning_effort=high'), effort.command);
  const museSwap = buildLaunch(muse, { model: 'muse-spark-1.3', resume: 'mid456' });
  assert.ok(museSwap.command.includes('--model muse-spark-1.3'), museSwap.command);
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

test('canonical permission levels map cleanly across harnesses without breaking exact mode ids', () => {
  const gemini = presets.find((p) => p.id === 'gemini')!;
  const grok = presets.find((p) => p.id === 'grok')!;
  const cursor = presets.find((p) => p.id === 'cursor')!;
  const copilot = presets.find((p) => p.id === 'copilot')!;

  // Exact ids stay exact.
  assert.equal(resolvePermissionMode(claude, 'dangerous')?.id, 'dangerous');
  assert.equal(resolvePermissionMode(codex, 'yolo')?.id, 'yolo');
  assert.equal(resolvePermissionMode(gemini, 'ask')?.id, 'ask');

  // Canonical levels map to each harness's native mode id.
  assert.equal(resolvePermissionMode(claude, 'bypass')?.id, 'dangerous');
  assert.equal(resolvePermissionMode(codex, 'bypass')?.id, 'yolo');
  assert.equal(resolvePermissionMode(gemini, 'bypass')?.id, 'yolo');
  assert.equal(resolvePermissionMode(grok, 'bypass')?.id, 'bypass');
  assert.equal(resolvePermissionMode(cursor, 'bypass')?.id, 'force');
  assert.equal(resolvePermissionMode(copilot, 'bypass')?.id, 'allow-all');
  assert.equal(resolvePermissionMode(muse, 'bypass')?.id, 'yolo');

  assert.equal(resolvePermissionMode(claude, 'ask')?.id, 'default');
  assert.equal(resolvePermissionMode(codex, 'ask')?.id, 'default');
  assert.equal(resolvePermissionMode(gemini, 'ask')?.id, 'ask');
  assert.equal(resolvePermissionMode(gemini, 'auto')?.id, 'default');
  assert.equal(resolvePermissionMode(claude, 'edits')?.id, 'accept-edits');
  assert.equal(resolvePermissionMode(cursor, 'auto')?.id, 'auto-review');
  assert.equal(resolvePermissionMode(claude, 'plan')?.id, 'plan');

  // Unsupported levels reject cleanly; shell never uses permission levels.
  assert.equal(resolvePermissionMode(codex, 'plan'), undefined);
  assert.equal(resolvePermissionMode(shell, 'bypass'), undefined);
  assert.equal(permissionLevelOf(shell, 'bash'), null);
  assert.equal(permissionLevelOf(claude, 'dangerous'), 'bypass');
  assert.equal(permissionLevelOf(gemini, 'default'), 'auto');

  // buildLaunch records the harness's real mode id when given a canonical level.
  const plan = buildLaunch(claude, { mode: 'bypass' });
  assert.equal(plan.meta['ah.launch.mode'], 'dangerous');
  assert.ok(plan.command.includes('--dangerously-skip-permissions'));
});

test('buildLaunch injects harness-native Space context flags cleanly', () => {
  const gemini = presets.find((p) => p.id === 'gemini')!;
  const grok = presets.find((p) => p.id === 'grok')!;

  const spaceContext = {
    addDir: '/home/me/.local/state/ah/spaces/sp-12345678',
    pointer: 'Agent House Space "Launch" (repo). Run `ah space context` anytime.',
  };

  const claudePlan = buildLaunch(claude, { spaceContext });
  assert.ok(claudePlan.args.includes('--add-dir'));
  assert.ok(claudePlan.args.includes(spaceContext.addDir));
  assert.ok(claudePlan.args.includes('--append-system-prompt'));
  assert.ok(claudePlan.args.includes(spaceContext.pointer));

  const codexPlan = buildLaunch(codex, { spaceContext });
  assert.ok(codexPlan.args.includes('--add-dir'));
  assert.ok(codexPlan.args.includes(spaceContext.addDir));
  assert.ok(!codexPlan.args.includes('--append-system-prompt'));
  assert.ok(codexPlan.args.includes('-c'));
  assert.ok(codexPlan.args.includes(`developer_instructions=${JSON.stringify(spaceContext.pointer)}`));

  const geminiPlan = buildLaunch(gemini, { spaceContext });
  assert.ok(geminiPlan.args.includes('--add-dir'));
  assert.ok(geminiPlan.args.includes(spaceContext.addDir));

  const grokPlan = buildLaunch(grok, { spaceContext });
  assert.ok(grokPlan.args.includes('--add-dir'));
  assert.ok(grokPlan.args.includes('--rules'));
  assert.ok(grokPlan.args.includes(spaceContext.pointer));

  // Harnesses without verified CLI flags get no extra flags (they use AH_SPACE* env vars + `ah space context`).
  const musePlan = buildLaunch(muse, { spaceContext });
  assert.ok(!musePlan.args.includes('--add-dir'));
});

test('buildLaunch injects built-in ah MCP flags for Claude and Codex cleanly', () => {
  const mcp = {
    configFile: '/home/me/.local/state/ah/mcp/ah-mcp.json',
    nodePath: '/usr/bin/node',
    ahBinPath: '/opt/ah/bin/ah.js',
    allowTools: true,
  };

  const claudePlan = buildLaunch(claude, { mcp });
  assert.ok(claudePlan.args.includes('--mcp-config'));
  assert.ok(claudePlan.args.includes(mcp.configFile));
  assert.ok(claudePlan.args.includes('--allowedTools'));
  assert.ok(claudePlan.args.includes('mcp__ah__*'));

  const codexPlan = buildLaunch(codex, { mcp });
  assert.ok(codexPlan.args.includes('mcp_servers.ah.command="/usr/bin/node"'));
  assert.ok(codexPlan.args.includes('mcp_servers.ah.args=["/opt/ah/bin/ah.js","mcp"]'));
  assert.ok(codexPlan.args.some((a) => a.startsWith('mcp_servers.ah.env_vars=[') && a.includes('"AH_SESSION_TOKEN"') && a.includes('"AH_ROLE"')));

  // Preserved on resume too.
  const codexResume = buildLaunch(codex, { resume: 'thread-123', mcp });
  assert.ok(codexResume.args.includes('mcp_servers.ah.command="/usr/bin/node"'));
});

test('a resume opens the conversation again where the agent can: by id, or the most recent here', () => {
  assert.equal(resumesConversation(claude, 'abc'), true);
  assert.equal(resumesConversation(codex, 'abc'), true);
  // Muse has no resume command: it starts a conversation of its own.
  assert.equal(resumesConversation(muse, 'abc'), false);
  assert.equal(resumesConversation({ resume: 'x --continue' }, 'abc'), true, 'the most recent here');
  assert.equal(resumesConversation({ resumeId: 'x --session {id}' }), false, 'by id, and no id');
});
