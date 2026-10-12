import { test } from 'node:test';
import assert from 'node:assert/strict';
import { age, runningModel, shortModel } from '../web/agents.ts';

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

test('ages read as people say them, and yesterday is the calendar day before', () => {
  const now = new Date(2026, 9, 13, 0, 30).getTime();
  const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo, d, h, mi).getTime() / 1000;
  assert.equal(age(now / 1000 - 30, now), 'now');
  assert.equal(age(now / 1000 - 600, now), '10m');
  assert.equal(age(at(2026, 9, 12, 12), now), 'yesterday');
  assert.equal(age(at(2026, 9, 11, 23), now), new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(2026, 9, 11)), '25.5h ago but two days back');
});
