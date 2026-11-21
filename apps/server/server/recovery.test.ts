// What an agent's own error words say, and what they don't.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, transcriptErrors, progressed } from './recovery/classify.ts';

test('classify: limits with their reset, provider trouble, network, credentials, and the unknown', () => {
  assert.deepEqual(classify('Claude AI usage limit reached|1763112000'), { reason: 'rate_limit', retryable: true, text: 'Claude AI usage limit reached|1763112000', resetsAt: 1763112000 });
  assert.equal(classify('429 Too Many Requests: retry after 30 seconds').retryAfter, 30);
  assert.equal(classify('rate_limit_error: try again in 2 minutes').retryAfter, 120);
  assert.equal(classify("You've hit your usage limit. Upgrade or try again at 3:10 PM.").reason, 'rate_limit');
  assert.equal(classify('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}').reason, 'provider_unavailable');
  assert.equal(classify('API Error: 503 Service Unavailable').reason, 'provider_unavailable');
  assert.equal(classify('stream disconnected before completion: ECONNRESET').reason, 'network');
  const creds = classify('Invalid API key · Please run /login');
  assert.equal(creds.reason, 'credentials');
  assert.equal(creds.retryable, false, 'credentials never retry on their own');
  assert.equal(classify('OAuth token has expired. Please obtain a new token').reason, 'credentials');
  assert.equal(classify('The tests failed: 3 assertions').reason, 'unknown', 'ordinary words are not a failure');
});

test('transcript errors and progress, per harness', () => {
  const claude = [
    JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }] } }),
    'not json',
  ];
  assert.deepEqual(transcriptErrors('claude', claude), ['API Error: 529 overloaded']);
  assert.equal(progressed('claude', claude.slice(0, 1)), false, 'an error line is not progress');
  assert.equal(progressed('claude', claude), true);
  const codex = [JSON.stringify({ type: 'event_msg', payload: { type: 'error', message: "You've hit your usage limit." } })];
  assert.deepEqual(transcriptErrors('codex', codex), ["You've hit your usage limit."]);
});
