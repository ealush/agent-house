import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortModel } from '../web/agents.ts';

test('model ids read as people say them', () => {
  assert.equal(shortModel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(shortModel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(shortModel('claude-sonnet-5-5[1m]'), 'Sonnet 5.5');
  assert.equal(shortModel('gpt-6.1-sol'), '6.1 Sol');
  assert.equal(shortModel('gemini-3-pro-latest'), '3 Pro');
  assert.equal(shortModel('default'), null);
  assert.equal(shortModel(null), null);
});
