import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.ts';

// The composer enables its model/effort pickers from these preset fields, and
// Core.switchLaunch builds the live command with String.replace — so a
// template without its placeholder would silently send a broken command.
const presets = loadConfig().presets;
const byId = (id: string) => presets.find((p) => p.id === id)!;

test('live-switch templates carry their placeholder', () => {
  for (const p of presets) {
    if (p.switchModel !== undefined) assert.ok(p.switchModel.includes('{model}'), `${p.id} switchModel needs {model}`);
    if (p.switchEffort !== undefined) assert.ok(p.switchEffort.includes('{level}'), `${p.id} switchEffort needs {level}`);
  }
});

test('composer can switch model live where the harness supports it', () => {
  assert.equal(byId('claude').switchModel, '/model {model}');
  assert.equal(byId('gemini').switchModel, '/model set {model}');
  assert.equal(byId('grok').switchModel, '/model {model}');
  assert.equal(byId('hermes').switchModel, '/model {model} --once');
  // codex and muse take no verified direct-switch argument (codex refuses
  // '/model <slug>' in-conversation), so they stay terminal-picker-only;
  // opencode's /models is likewise a picker.
  assert.equal(byId('codex').switchModel, undefined);
  assert.equal(byId('muse').switchModel, undefined);
  assert.equal(byId('opencode').switchModel, undefined);
  assert.equal(byId('opencode').settingsCommands?.model, '/models');
});

test('composer can switch effort live where the harness supports it', () => {
  assert.equal(byId('claude').switchEffort, '/effort {level}');
  assert.equal(byId('muse').switchEffort, '/effort {level}');
  assert.equal(byId('grok').switchEffort, '/effort {level}');
  assert.equal(byId('hermes').switchEffort, '/reasoning {level}');
  // codex effort goes through the /model picker; gemini/opencode have no effort setting.
  assert.equal(byId('codex').switchEffort, undefined);
  assert.equal(byId('codex').settingsCommands?.effort, '/model');
  assert.equal(byId('gemini').effort, undefined);
  assert.equal(byId('opencode').effort, undefined);
});

test('effort levels match each CLI', () => {
  assert.deepEqual(byId('grok').effort?.levels, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(byId('hermes').effort?.levels, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});
