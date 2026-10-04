import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyboardViewportHeight, trackViewport } from '../web/viewport.ts';

test('a smaller visual viewport with the keyboard closed does not shorten the app', () => {
  assert.equal(keyboardViewportHeight(868, 808, 1, false), null);
  assert.equal(keyboardViewportHeight(868, 808, 1, true), null, 'hardware keyboard focus is not a software keyboard');
  assert.equal(keyboardViewportHeight(868, 500, 1, false), null, 'blur restores CSS height before resize arrives');
});

test('a docked keyboard shrinks the app, while zoom does not resize it', () => {
  assert.equal(keyboardViewportHeight(868, 500, 1, true), 500);
  assert.equal(keyboardViewportHeight(390, 210, 1, true), 210, 'landscape keyboard');
  assert.equal(keyboardViewportHeight(868, 500, 1.5, true), null);
  assert.equal(keyboardViewportHeight(868, 0, 1, true), null);
});

test('keyboard dismissal restores full height and pending resize work is cleaned up', () => {
  const viewport = Object.assign(new EventTarget(), { height: 808, scale: 1 });
  const callbacks = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  const win = Object.assign(new EventTarget(), {
    visualViewport: viewport,
    requestAnimationFrame(fn: FrameRequestCallback) { callbacks.set(++sequence, fn); return sequence; },
    cancelAnimationFrame(id: number) { callbacks.delete(id); },
  });
  const style = new Map([['--vh', '808px']]);
  const doc = Object.assign(new EventTarget(), {
    activeElement: null as unknown,
    documentElement: {
      clientHeight: 868,
      style: {
        setProperty(key: string, value: string) { style.set(key, value); },
        removeProperty(key: string) { style.delete(key); },
      },
    },
  });
  const flush = () => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((fn) => fn(0));
  };
  const stop = trackViewport(win as unknown as Window, doc as unknown as Document);
  assert.equal(style.has('--vh'), false, 'stale pixel override removed on mount');
  doc.activeElement = { matches: () => true, isContentEditable: false };
  viewport.height = 500;
  doc.dispatchEvent(new Event('focusin'));
  viewport.dispatchEvent(new Event('resize'));
  assert.equal(callbacks.size, 1, 'events coalesce');
  flush();
  assert.equal(style.get('--vh'), '500px');
  viewport.height = 808;
  viewport.dispatchEvent(new Event('scroll'));
  flush();
  assert.equal(style.has('--vh'), false, 'keyboard hide restores CSS even if textarea stays focused');
  viewport.height = 500;
  viewport.dispatchEvent(new Event('resize'));
  flush();
  doc.activeElement = null;
  doc.dispatchEvent(new Event('focusout'));
  flush();
  assert.equal(style.has('--vh'), false);
  win.dispatchEvent(new Event('pageshow'));
  stop();
  assert.equal(callbacks.size, 0);
  viewport.dispatchEvent(new Event('resize'));
  doc.dispatchEvent(new Event('focusin'));
  assert.equal(callbacks.size, 0, 'all listeners removed');
});
