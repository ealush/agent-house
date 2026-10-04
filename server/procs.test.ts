import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descendants } from './procs.ts';

test('exec-replaced pane roots are included for agent detection', () => {
  const root = { pid: 10, ppid: 1, argv: ['python', '/p/hermes'] };
  const child = { pid: 11, ppid: 10, argv: ['bash', '-c', 'sleep 60'] };
  const procs = new Map([[1, [root]], [10, [child]]]);
  assert.deepEqual(descendants(procs, 10), [child]);
  assert.deepEqual(descendants(procs, 10, true), [root, child]);
  assert.deepEqual(descendants(procs, 99, true), []);
});
