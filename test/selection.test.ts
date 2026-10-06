import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoCopySelection, copyText, legacyCopy } from '../web/selection.ts';

function harness(write?: (text: string) => Promise<void>) {
  const document = new EventTarget();
  const element = Object.assign(new EventTarget(), { ownerDocument: document });
  const writes: string[] = [];
  let text = '';
  let listener = () => {};
  const stop = autoCopySelection(element, {
    getSelection: () => text,
    onSelectionChange: (fn) => { listener = fn; return { dispose: () => { listener = () => {}; } }; },
  }, () => ({ writeText: write ?? (async (value) => { writes.push(value); }) }));
  return { element, document, writes, stop, select: (value: string) => { text = value; listener(); } };
}

test('drag selection copies the final text, including line breaks, even when released outside', () => {
  const h = harness();
  h.element.dispatchEvent(new Event('pointerdown'));
  h.select('partial');
  h.select('final\nselection');
  assert.deepEqual(h.writes, []);
  h.document.dispatchEvent(new Event('pointerup'));
  assert.deepEqual(h.writes, ['final\nselection']);
  h.document.dispatchEvent(new Event('pointerup'));
  assert.equal(h.writes.length, 1, 'unrelated clicks do not overwrite the clipboard');
  h.stop();
});

test('keyboard selections copy, deselection never clears the clipboard, disposal removes listeners', () => {
  const h = harness();
  h.select('chosen');
  h.element.dispatchEvent(new Event('keyup'));
  assert.deepEqual(h.writes, ['chosen']);
  h.select('');
  assert.deepEqual(h.writes, ['chosen']);
  h.select('chosen');
  assert.deepEqual(h.writes, ['chosen', 'chosen']);
  h.stop();
  h.select('after disposal');
  h.element.dispatchEvent(new Event('keyup'));
  assert.equal(h.writes.length, 2);
});

test('denied clipboard access leaves selection usable and permits a later retry', async () => {
  let attempts = 0;
  const h = harness(async () => { if (++attempts === 1) throw new Error('Denied'); });
  h.select('keep selection');
  await Promise.resolve();
  h.element.dispatchEvent(new Event('keyup'));
  assert.equal(attempts, 2);
  h.stop();
});

// Plain-http origins have no async Clipboard API: stub document.execCommand and
// prove selections still land on the clipboard instead of being dropped.
function stubExecCopy() {
  const g = globalThis as Record<string, unknown>;
  const prev = g.document;
  const copied: string[] = [];
  let area: { value: string } | null = null;
  g.document = {
    createElement: () => (area = {
      value: '',
      style: {},
      setAttribute: () => {},
      select: () => {},
      remove: () => {},
    }),
    body: { appendChild: () => {} },
    execCommand: (cmd: string) => {
      if (cmd === 'copy' && area) copied.push(area.value);
      return true;
    },
  };
  return { copied, restore: () => { g.document = prev; } };
}

test('without the async clipboard, selections copy via the execCommand fallback', () => {
  const stub = stubExecCopy();
  try {
    const document = new EventTarget();
    const element = Object.assign(new EventTarget(), { ownerDocument: document });
    let text = '';
    let listener = () => {};
    const stop = autoCopySelection(element, {
      getSelection: () => text,
      onSelectionChange: (fn) => { listener = fn; return { dispose: () => { listener = () => {}; } }; },
    }, () => undefined);
    element.dispatchEvent(new Event('pointerdown'));
    text = 'fallback\nselection';
    listener();
    document.dispatchEvent(new Event('pointerup'));
    assert.deepEqual(stub.copied, ['fallback\nselection']);
    stop();
  } finally {
    stub.restore();
  }
});

test('copyText prefers the async clipboard and falls back when it rejects', async () => {
  assert.equal(await copyText('fast', { writeText: async () => {} }), true);
  const stub = stubExecCopy();
  try {
    assert.equal(await copyText('slow', { writeText: async () => { throw new Error('Denied'); } }), true);
    assert.deepEqual(stub.copied, ['slow']);
  } finally {
    stub.restore();
  }
});

test('legacyCopy reports failure instead of throwing when no document exists', () => {
  assert.equal(legacyCopy('nothing to copy to'), false);
});
