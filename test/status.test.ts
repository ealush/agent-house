import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusCounts, statusWord } from '../web/status.ts';

test('one word per status, shells and agents alike', () => {
  assert.equal(statusWord({ status: 'busy', agent: null }), 'working');
  assert.equal(statusWord({ status: 'busy', agent: 'claude' }), 'working');
  assert.equal(statusWord({ status: 'waiting', agent: 'claude' }), 'needs you');
  assert.equal(statusWord({ status: 'attention', agent: 'codex' }), 'done');
  assert.equal(statusWord({ status: 'attention', agent: null }), 'new output');
  assert.equal(statusWord({ status: 'idle', agent: null }), 'idle');
  assert.equal(statusWord({ status: 'attention', agent: 'claude', limit: 'Session limit · resets 12am' }), 'limited');
  assert.equal(statusWord({ status: 'busy', agent: 'claude', limit: 'Session limit · resets 12am' }), 'working', 'working again: the limit is over');
});

test('counts read as one sentence per status', () => {
  assert.equal(statusCounts([]), 'All quiet.');
  assert.equal(statusCounts([{ status: 'busy' }, { status: 'idle' }, { status: 'attention' }, { status: 'idle' }]), '1 working. 3 idle.');
  assert.equal(statusCounts([{ status: 'waiting' }, { status: 'waiting' }]), '2 sessions need you.');
});
