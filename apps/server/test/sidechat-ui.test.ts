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

test('your bubble appears before the reply round-trip starts', () => {
  const submit = tsx.slice(tsx.indexOf('function submit('), tsx.indexOf('function retry('));
  const bubble = submit.indexOf("{ role: 'user', text: trimmed");
  assert.ok(bubble >= 0, 'submit appends the user row optimistically');
  const slot = submit.indexOf("{ role: 'assistant', text: ''");
  assert.ok(slot > bubble, 'the answer slot is reserved right below it');
  const chain = submit.indexOf('enqueue(userKey, asstKey, trimmed, subId)');
  assert.ok(chain > slot, 'the bubble and its slot land first, the POST chains after');
  assert.doesNotMatch(submit, /sendChat|await client/, 'submit never touches the network itself');
});

test('each answer fills its own reserved slot and keeps its own follow-ups', () => {
  assert.ok(tsx.includes('followups: reply.followups'), 'the reply fills its own slot with its follow-ups');
  assert.ok(tsx.includes('m.followups?.length'), 'suggestions render per answer, not global');
});

test('a failed send drops its reserved slot and keeps a retry', () => {
  assert.ok(tsx.includes('.filter((m) => m.key !== asstKey)'), 'the empty slot goes away with the failure');
});

test('a reply appends in place; the thread is not re-fetched', () => {
  assert.ok(tsx.includes('...reply.message'), 'the answered message lands from the reply');
  const chats = tsx.match(/\.chat\(/g) ?? [];
  assert.equal(chats.length, 1, 'history loads once on open, never per send');
});

test('sends serialize behind one chain so concurrent replies cannot interleave', () => {
  assert.ok(tsx.includes('tailRef'), 'a promise chain serializes sends');
  const posts = tsx.match(/client\.sendChat\(/g) ?? [];
  assert.equal(posts.length, 1, 'one POST site, always through the chain');
});

test('a failed send stays on screen with a retry, keyed stably', () => {
  assert.ok(tsx.includes("state: 'failed'"), 'failed rows keep their state');
  assert.match(tsx, />\s*Retry\s*</, 'failed rows offer a retry');
  assert.ok(tsx.includes('key={m.key}'), 'rows keyed by stable id, not position');
  assert.doesNotMatch(tsx, /key=\{i\}/, 'no index keys to remount the thread');
});

test('the waiting reply shows a live indicator that honors reduced motion', () => {
  assert.ok(css.includes('.sidechat-thinking'), 'indicator style exists');
  assert.ok(css.includes('.thinking-dots'), 'dots style exists');
  assert.ok(css.includes('@keyframes thinking-pulse'), 'dots animate');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.thinking-dots')));
  assert.ok(reduced.includes('.thinking-dots'), 'reduced motion stills the dots');
});
