import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runningModel, shortModel } from '../web/agents.ts';

test('model ids read as people say them', () => {
  assert.equal(shortModel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(shortModel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(shortModel('claude-sonnet-5-5[1m]'), 'Sonnet 5.5');
  assert.equal(shortModel('gpt-6.1-sol'), '6.1 Sol');
  assert.equal(shortModel('gemini-3-pro-latest'), '3 Pro');
  assert.equal(shortModel('default'), null);
  assert.equal(shortModel(null), null);
});

test('the running model maps onto the preset choice that names it', () => {
  const models = [{ id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }, { id: 'gpt-6.1-sol' }];
  assert.equal(runningModel(models, 'claude-haiku-4-5-20251001')?.id, 'haiku');
  assert.equal(runningModel(models, 'claude-opus-5-5[1m]')?.id, 'opus');
  assert.equal(runningModel(models, 'gpt-6.1-sol')?.id, 'gpt-6.1-sol');
  assert.equal(runningModel(models, 'muse-spark-1.3'), undefined);
  assert.equal(runningModel(models, null), undefined);
});
