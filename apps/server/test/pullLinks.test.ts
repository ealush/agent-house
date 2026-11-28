import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPulls, pullLabel, pullOf, reviewable } from '../web/pullLinks.ts';

test('pullOf reads a pull request from any page of it on GitHub, and nothing else', () => {
  assert.deepEqual(pullOf('https://github.com/ealush/agent-house/pull/223'), { repo: 'ealush/agent-house', number: 223 });
  assert.deepEqual(pullOf('https://github.com/ealush/agent-house/pull/223/files#diff-1'), { repo: 'ealush/agent-house', number: 223 });
  assert.deepEqual(pullOf('https://www.github.com/a/b.c/pull/7?w=1'), { repo: 'a/b.c', number: 7 });
  assert.equal(pullOf('https://github.com/ealush/agent-house/issues/223'), null);
  assert.equal(pullOf('https://github.com/ealush/agent-house/pull/223x'), null);
  assert.equal(pullOf('https://gitlab.com/ealush/agent-house/pull/223'), null);
});

test('findPulls finds each link in prose, without the brackets or stop round it', () => {
  const text = 'The confirmation fix is up as PR #223 (https://github.com/ealush/agent-house/pull/223). Also https://github.com/o/r/pull/9/files, and #12.';
  const found = findPulls(text);
  assert.deepEqual(
    found.map((p) => [p.repo, p.number, text.slice(p.start, p.end)]),
    [
      ['ealush/agent-house', 223, 'https://github.com/ealush/agent-house/pull/223'],
      ['o/r', 9, 'https://github.com/o/r/pull/9/files'],
    ],
  );
});

test('a chip says the repository and number, and only a repository this host reviews gets one', () => {
  assert.equal(pullLabel({ repo: 'ealush/agent-house', number: 223 }), 'agent-house#223');
  const repos = new Set(['ealush/agent-house']);
  assert.equal(reviewable(repos, pullOf('https://github.com/Ealush/Agent-House/pull/1')), true);
  assert.equal(reviewable(repos, pullOf('https://github.com/other/repo/pull/1')), false);
  assert.equal(reviewable(null, pullOf('https://github.com/ealush/agent-house/pull/1')), false);
});
