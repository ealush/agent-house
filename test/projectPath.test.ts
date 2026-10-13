// New session's Project field: a project's name means that project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bareProject } from '../web/projectPath.ts';

const projects = ['/home/u/code/acme-web', '/home/u/code/payments-api', '/srv/a/tools', '/srv/b/tools/'];

test('a bare name that is one known project is that project', () => {
  assert.equal(bareProject('acme-web', projects), '/home/u/code/acme-web');
  assert.equal(bareProject(' payments-api ', projects), '/home/u/code/payments-api');
});

test('paths, unknown names and ambiguous names stay as typed', () => {
  assert.equal(bareProject('~/code/acme-web', projects), null);
  assert.equal(bareProject('/home/u/code/acme-web', projects), null);
  assert.equal(bareProject('acme', projects), null);
  assert.equal(bareProject('tools', projects), null, 'two projects are called tools');
  assert.equal(bareProject('', projects), null);
});
