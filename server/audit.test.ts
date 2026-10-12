import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenAudit } from './audit.ts';

test('a prompt the screen rules saw at any point is a catch, not a miss', () => {
  const a = new ScreenAudit(null);
  a.observe('@1:100', 'claude', false, 'command', 'half drawn');
  a.observe('@1:100', 'claude', true, 'command', 'Do you want to proceed?');
  a.sweep(new Set(['@1:100']));
  assert.deepEqual(a.summary(), {}, 'still open: nothing counted yet');
  a.sweep(new Set());
  assert.deepEqual(a.summary(), { claude: { checked: 1, missed: 0 } });
});

test('a prompt the screen rules never saw is a miss, kept with its screen', () => {
  const a = new ScreenAudit(null);
  a.observe('@2:7', 'claude', false, 'tool', 'Allow this edit? 1. Yes 2. No');
  a.sweep(new Set());
  a.observe('@2:9', 'codex', true, 'command', 'Run this?');
  a.sweep(new Set());
  const s = a.summary();
  assert.equal(s.claude.missed, 1);
  assert.equal(s.claude.last?.screen, 'Allow this edit? 1. Yes 2. No');
  assert.equal(s.codex.missed, 0);
  a.reset();
  assert.deepEqual(a.summary(), {});
});
