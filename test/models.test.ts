import { test } from 'node:test';
import assert from 'node:assert/strict';
import { age, frontAgents, runningModel, shortModel } from '../web/agents.ts';

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

test('New session gives buttons to the three agents used most, in their usual order', () => {
  const agents = ['claude', 'codex', 'gemini', 'grok', 'cursor', 'pi'].map((id) => ({ id }));
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  // Nothing known yet: the presets' own order.
  assert.deepEqual(ids(frontAgents(agents, [], {}, 3)), ['claude', 'codex', 'gemini']);
  // Started here most, but drawn in the presets' order, so buttons don't move about.
  assert.deepEqual(ids(frontAgents(agents, [], { pi: 9, grok: 4, claude: 2, codex: 1 }, 3)), ['claude', 'grok', 'pi']);
  // A new device starts from what the host runs; shells and unknown agents don't count.
  assert.deepEqual(ids(frontAgents(agents, ['cursor', 'cursor', null, 'aider', 'codex'], {}, 3)), ['claude', 'codex', 'cursor']);
});
