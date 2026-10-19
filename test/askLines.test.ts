import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickedLines } from '../web/review/askLines.ts';

const lines = [
  { kind: 'hunk' as const, text: '… plan', n: null },
  { kind: 'ctx' as const, text: 'const a = 1;', n: 10 },
  { kind: 'del' as const, text: 'walk(all);', n: 11 },
  { kind: 'del' as const, text: 'return all;', n: 12 },
  { kind: 'add' as const, text: 'walk(one);', n: 11 },
  { kind: 'ctx' as const, text: '}', n: 12 },
];

test('a picked range reads as the diff shows it, numbered by the new side', () => {
  assert.deepEqual(pickedLines(lines, 'src/a.ts', 5, 0), { path: 'src/a.ts', start: 10, end: 12, text: ' const a = 1;\n-walk(all);\n-return all;\n+walk(one);\n }', removed: false });
});

test('only removed lines keep the old side\'s numbers, and say so', () => {
  assert.deepEqual(pickedLines(lines, 'src/a.ts', 2, 3), { path: 'src/a.ts', start: 11, end: 12, text: '-walk(all);\n-return all;', removed: true });
});

test('one line is a range of one', () => {
  const one = pickedLines(lines, 'src/a.ts', 4);
  assert.equal(one.start, 11);
  assert.equal(one.end, 11);
});
