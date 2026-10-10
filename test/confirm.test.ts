import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primaryButton, registerConfirm } from '../web/confirm.ts';

// A tiny DOM stand-in: just what primaryButton reads.
type Node = { parent: Node | null; tag: string; attrs: Set<string>; disabled?: boolean; cls?: string };
function el(tag: string, parent: Node | null, attrs: string[] = [], extra: Partial<Node> = {}): any {
  const n: any = { parent, tag, attrs: new Set(attrs), ...extra };
  n.isConnected = true;
  n.getClientRects = () => [1];
  n.closest = (sel: string) => {
    for (let c: any = n; c; c = c.parent) {
      if (sel === '.xterm' && c.cls === 'xterm') return c;
      if (sel === '[data-confirm]' && c.attrs.has('data-confirm')) return c;
      if (sel === '[hidden], .hidden' && (c.attrs.has('hidden') || c.cls === 'hidden')) return c;
    }
    return null;
  };
  n.contains = (o: any) => {
    for (let c = o; c; c = c.parent) if (c === n) return true;
    return false;
  };
  return n;
}

test('⌘↵ presses the confirm button of the context the keyboard is in', () => {
  const body = el('body', null);
  const screen = el('section', body, ['data-confirm']);
  const field = el('input', screen);
  const start = el('button', screen);
  const elsewhere = el('textarea', body);
  const term = el('textarea', el('div', body, [], { cls: 'xterm' }));
  const off = registerConfirm(start);
  const doc: any = { body, documentElement: el('html', null), querySelectorAll: () => [] };
  assert.equal(primaryButton(field, doc), start, 'from a field in the screen');
  assert.equal(primaryButton(body, doc), start, 'with nothing focused');
  assert.equal(primaryButton(elsewhere, doc), null, 'not from a field outside it');
  assert.equal(primaryButton(term, doc), null, 'a terminal keeps the key');
  start.disabled = true;
  assert.equal(primaryButton(field, doc), null, 'a disabled button is skipped');
  start.disabled = false;
  const dialog = el('dialog', body);
  const ok = el('button', dialog);
  const offOk = registerConfirm(ok);
  const withDialog: any = { ...doc, querySelectorAll: () => [dialog] };
  assert.equal(primaryButton(field, withDialog), ok, 'an open dialog is the context');
  offOk();
  off();
  assert.equal(primaryButton(field, doc), null, 'unmounted buttons are gone');
});
