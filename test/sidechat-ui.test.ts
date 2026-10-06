import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Side-chat panel regressions with no DOM harness: assert on the shipped
// source, like test/api-version.test.ts does. A hover reveal that takes space
// pushes later messages down; new arrivals must anchor by their top.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'web', 'styles.css'), 'utf8');
const tsx = readFileSync(join(root, 'web', 'SideChat.tsx'), 'utf8');

function block(selector: string): string {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `${selector} rule exists`);
  const end = css.indexOf('}', i);
  return css.slice(i, end);
}

test('message actions overlay without taking space', () => {
  const base = block('.sidechat-msg .msg-actions {');
  assert.match(base, /position:\s*absolute/, 'out of flow: reveal cannot shift later messages');
  assert.match(base, /visibility:\s*hidden/, 'hidden without collapsing height tricks');
  assert.doesNotMatch(base, /height:\s*0/, 'no zero-height placeholder');
  assert.doesNotMatch(base, /background:/, 'plain text links, no pill backdrop');
  assert.match(base, /padding:/, 'inset from the message edge');
  assert.ok(css.includes('.sidechat-msg .msg-actions .btn'), 'button chrome neutralized');
});

test('hover reveal changes visibility only, never layout', () => {
  const i = css.indexOf('.sidechat-msg:hover .msg-actions');
  assert.ok(i >= 0, 'hover rule exists');
  const rule = css.slice(i, css.indexOf('}', i));
  assert.match(rule, /visibility:\s*visible/);
  assert.doesNotMatch(rule, /height:/, 'reveal must not grow the message box');
  assert.doesNotMatch(rule, /position:/, 'overlay geometry stays put');
});

test('new arrivals scroll to the first new message top, not the bottom', () => {
  assert.ok(tsx.includes('Math.min(prevLenRef.current, messages.length - 1)'), 'first-new index computed');
  assert.ok(tsx.includes("scrollIntoView({ block: 'start' })"), 'anchored by top');
  assert.doesNotMatch(tsx, /scrollTop\s*=\s*el\.scrollHeight/, 'no jump-to-bottom remains');
});
