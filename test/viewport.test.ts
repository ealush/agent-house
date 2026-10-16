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
      dataset: {} as Record<string, string>,
      classList: (() => {
        const set = new Set<string>();
        return { add: (c: string) => set.add(c), remove: (c: string) => set.delete(c), contains: (c: string) => set.has(c) };
      })(),
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
  assert.equal(style.get('--keyboard-vh'), '500px', 'the app shell tracks the keyboard, not 100dvh');
  assert.equal(doc.documentElement.dataset.keyboard, '1', 'safe-area padding drops while the keyboard covers it');
  assert.equal(style.get('--keyboard-top'), '0px', 'the shell follows the visual viewport offset');
  viewport.height = 808;
  viewport.dispatchEvent(new Event('scroll'));
  flush();
  assert.equal(style.has('--vh'), false, 'keyboard hide restores CSS even if textarea stays focused');
  assert.equal(style.has('--keyboard-vh'), false);
  assert.equal(doc.documentElement.dataset.keyboard, undefined);
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

test('a stale small override is re-synced even when iOS fires no dismissal events', () => {
  const viewport = Object.assign(new EventTarget(), { height: 500, scale: 1 });
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  const timers = new Map<number, () => void>();
  const win = Object.assign(new EventTarget(), {
    visualViewport: viewport,
    requestAnimationFrame(fn: FrameRequestCallback) { frames.set(++sequence, fn); return sequence; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    setInterval(fn: () => void) { timers.set(++sequence, fn); return sequence; },
    clearInterval(id: number) { timers.delete(id); },
  });
  const style = new Map<string, string>();
  const doc = Object.assign(new EventTarget(), {
    activeElement: { matches: () => true, isContentEditable: false },
    documentElement: {
      dataset: {} as Record<string, string>,
      classList: (() => {
        const set = new Set<string>();
        return { add: (c: string) => set.add(c), remove: (c: string) => set.delete(c), contains: (c: string) => set.has(c) };
      })(),
      clientHeight: 868,
      style: {
        setProperty(key: string, value: string) { style.set(key, value); },
        removeProperty(key: string) { style.delete(key); },
      },
    },
  });
  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((fn) => fn(0));
  };
  const runTimers = () => [...timers.values()].forEach((fn) => fn());
  const stop = trackViewport(win as unknown as Window, doc as unknown as Document);
  // Keyboard opens: override set, guard timer starts.
  viewport.dispatchEvent(new Event('resize'));
  flushFrames();
  assert.equal(style.get('--vh'), '500px');
  assert.equal(timers.size, 1, 'guard runs only while the override is set');
  // Keyboard closes with no events at all (stale height, focus kept).
  viewport.height = 808;
  runTimers();
  assert.equal(style.has('--vh'), false, 'guard restores full height without waiting for events');
  assert.equal(timers.size, 0, 'guard stops once the override is gone');
  stop();
});

test('an iOS home-screen app fills the screen when the viewport is short by the status bar', async () => {
  const { standaloneHeight } = await import('../web/viewport.ts');
  const iphone = { standalone: true, ios: true, portrait: true, screenW: 402, screenH: 874, inner: 812 };
  assert.equal(standaloneHeight(iphone), 874);
  assert.equal(standaloneHeight({ ...iphone, inner: 874 }), null, 'no gap, nothing to fix');
  assert.equal(standaloneHeight({ ...iphone, standalone: false }), null, 'Safari tabs have real browser chrome');
  assert.equal(standaloneHeight({ ...iphone, ios: false }), null, "Android's screen height includes its nav bar");
  assert.equal(standaloneHeight({ ...iphone, inner: 500 }), null, 'a keyboard-sized gap is not the status bar');
  assert.equal(standaloneHeight({ ...iphone, portrait: false, inner: 340 }), 402, 'landscape uses the short side');
});

test('typing on a hardware keyboard puts the shim aside, so the caret is inside the fixed shell', () => {
  const viewport = Object.assign(new EventTarget(), { height: 810, scale: 1 });
  const frames: FrameRequestCallback[] = [];
  const win = Object.assign(new EventTarget(), {
    visualViewport: viewport,
    innerHeight: 810,
    screen: { width: 1194, height: 834 },
    navigator: { standalone: true, userAgent: 'iPad', maxTouchPoints: 5 },
    matchMedia: (q: string) => ({ matches: q.includes('standalone') }),
    requestAnimationFrame(fn: FrameRequestCallback) { frames.push(fn); return frames.length; },
    cancelAnimationFrame() {},
    scrollY: 0,
    scrollTo() {},
  });
  const classes = new Set<string>();
  const style = new Map<string, string>();
  const doc = Object.assign(new EventTarget(), {
    activeElement: null as unknown,
    documentElement: {
      dataset: {} as Record<string, string>,
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
      clientHeight: 810,
      style: {
        setProperty(key: string, value: string) { style.set(key, value); },
        removeProperty(key: string) { style.delete(key); },
      },
    },
  });
  const flush = () => frames.splice(0).forEach((fn) => fn(0));
  const stop = trackViewport(win as unknown as Window, doc as unknown as Document);
  assert.ok(classes.has('ios-shim'), 'landscape iPad, 24pt short: stretched');
  // A hardware keyboard: focus, but the visual viewport stays about the same.
  doc.activeElement = { matches: () => true, isContentEditable: false };
  doc.dispatchEvent(new Event('focusin'));
  flush();
  assert.equal(classes.has('ios-shim'), false, 'the shell is fixed while typing');
  assert.equal(style.has('--keyboard-vh'), false, 'no software keyboard to fit');
  doc.activeElement = null;
  doc.dispatchEvent(new Event('focusout'));
  flush();
  assert.ok(classes.has('ios-shim'), 'and stretched again after');
  assert.equal(style.get('--app-h'), '834px');
  stop();
});

test('the measured shim is kept, so the stretched page does not switch it off again', async () => {
  const { nextShim } = await import('../web/viewport.ts');
  const iphone = { standalone: true, ios: true, portrait: true, screenW: 402, screenH: 874, inner: 812 };
  const first = nextShim(null, iphone);
  assert.deepEqual(first, { portrait: true, full: 874 });
  // With the fix on, iOS reports the stretched height: no gap. The fix must stay on.
  assert.deepEqual(nextShim(first, { ...iphone, inner: 874 }), first);
  // Turning the phone re-measures.
  assert.equal(nextShim(first, { ...iphone, portrait: false, inner: 402 }), null);
  assert.equal(nextShim(first, { ...iphone, standalone: false }), null);
});
