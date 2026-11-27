import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusCounts, statusWord, unseen } from '../web/status.ts';

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
  assert.equal(statusCounts([{ status: 'busy' }, { status: 'idle' }, { status: 'attention' }, { status: 'idle' }]), '1 working. 1 new output. 2 idle.');
  assert.equal(
    statusCounts([{ status: 'attention', agent: 'claude' }, { status: 'attention', agent: 'codex', limit: 'Weekly limit · resets Mon' }, { status: 'idle', agent: null }]),
    '1 limited. 1 done. 1 idle.',
    'the tagline uses the same words as the sections below it',
  );
  assert.equal(statusCounts([{ status: 'waiting' }, { status: 'waiting' }]), '2 sessions need you.');
});

test('unseen is a turn that ended, or a question asked, while nobody looked', () => {
  assert.equal(unseen({ status: 'attention' }), true, 'a finished turn nobody viewed');
  assert.equal(unseen({ status: 'waiting' }), true, 'a question waiting on you');
  assert.equal(unseen({ status: 'idle' }), false, 'viewed: read');
  assert.equal(unseen({ status: 'busy' }), false, 'still working: nothing to read yet');
});
