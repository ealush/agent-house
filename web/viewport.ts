// The app shell is pinned to the layout viewport. Only override its height for
// a software keyboard: a smaller visual viewport can also be browser chrome or
// pinch zoom. Dialogs and the lock screen still use --vh (CSS 100dvh).
// https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport
export function keyboardViewportHeight(layoutHeight: number, visualHeight: number, scale: number, editing: boolean): number | null {
  if (!editing || !Number.isFinite(visualHeight) || visualHeight <= 0 || Math.abs(scale - 1) > 0.05) return null;
  // Normal browser/safe-area differences are much smaller than a docked keyboard.
  if (layoutHeight - visualHeight < 120) return null;
  return visualHeight;
}

/**
 * iOS home-screen apps can get a layout viewport that stops ~60pt short of the
 * screen bottom (the "bottom shim"). position: fixed is measured against that
 * viewport and clipped to it, so a fixed shell either leaves a blank band or,
 * stretched, gets cut off. With a shim the document is stretched to the screen
 * and the shell is positioned absolutely in it (styles.css, :root.ios-shim),
 * since ordinary content paints all the way down. Only iOS standalone, and only
 * for a shim-sized gap (Android's screen height includes its navigation bar).
 */
export function standaloneHeight(o: { standalone: boolean; ios: boolean; portrait: boolean; screenW: number; screenH: number; inner: number }): number | null {
  if (!o.standalone || !o.ios) return null;
  const full = o.portrait ? Math.max(o.screenW, o.screenH) : Math.min(o.screenW, o.screenH);
  const short = full - o.inner;
  return short >= 16 && short <= 100 ? full : null;
}

function standaloneInfo(win: Window) {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  const media = (q: string) => typeof win.matchMedia === 'function' && win.matchMedia(q).matches;
  return {
    standalone: media('(display-mode: standalone)') || nav?.standalone === true,
    ios: /iPhone|iPad|iPod/.test(nav?.userAgent ?? '') || (/Macintosh/.test(nav?.userAgent ?? '') && (nav?.maxTouchPoints ?? 0) > 1),
    portrait: media('(orientation: portrait)'),
    screenW: win.screen?.width ?? 0,
    screenH: win.screen?.height ?? 0,
    inner: win.innerHeight ?? 0,
  };
}

export function trackViewport(win: Window, doc: Document): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};
  const root = doc.documentElement;
  // Window timers in the browser, global timers under test fakes.
  const hasTimers = typeof win.setInterval === 'function' && typeof win.clearInterval === 'function';
  let frame: number | null = null;
  // While a pixel override is active, re-read the viewport on a timer: iOS does
  // not reliably fire resize/scroll/focus events when its keyboard dismisses,
  // and a stale small --vh leaves dead space under the app (mobile Inbox and
  // Session views). The timer only runs while the override is set.
  let guard: number | NodeJS.Timeout | undefined;
  const badge = mountVhBadge(win, doc);
  const update = () => {
    frame = null;
    const active = doc.activeElement as HTMLElement | null;
    const editing = !!active && (active.isContentEditable || active.matches(
      'textarea, input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"])',
    ));
    const height = keyboardViewportHeight(root.clientHeight, viewport.height, viewport.scale, editing);
    const full = height === null ? standaloneHeight(standaloneInfo(win)) : null;
    if (full !== null) {
      root.style.setProperty('--app-h', `${full}px`);
      root.classList.add('ios-shim');
    } else {
      root.style.removeProperty('--app-h');
      root.classList.remove('ios-shim');
    }
    if (height === null) {
      root.style.removeProperty('--vh');
      root.style.removeProperty('--keyboard-vh');
      root.style.removeProperty('--keyboard-top');
      delete root.dataset.keyboard;
      if (guard !== undefined) {
        if (hasTimers) win.clearInterval(guard as number);
        else clearInterval(guard as NodeJS.Timeout);
        guard = undefined;
      }
    } else {
      root.style.setProperty('--vh', `${height}px`);
      root.style.setProperty('--keyboard-vh', `${height}px`);
      // Safari scrolls the page to keep the field in view; the shell follows, so
      // nothing slides under the top edge and no gap opens above the keyboard.
      root.style.setProperty('--keyboard-top', `${Math.max(0, Math.round(viewport.offsetTop ?? 0))}px`);
      // The home indicator is behind the keyboard: its inset would be a gap.
      root.dataset.keyboard = '1';
      if (guard === undefined) {
        guard = hasTimers ? win.setInterval(update, 500) : setInterval(update, 500);
        // Never hold a test runner (or a background tab) open for debug timing.
        (guard as unknown as { unref?: () => void })?.unref?.();
      }
    }
    badge?.refresh(editing);
  };
  // Read fresh dimensions after the browser has applied resize/focus changes.
  const schedule = () => {
    if (frame === null) frame = win.requestAnimationFrame(update);
  };
  // The stretched document is a little taller than the viewport: keep it from
  // scrolling (inner scrollers are unaffected), or the shell slides up.
  const pin = () => {
    if (root.classList.contains('ios-shim') && (win.scrollY || 0) !== 0) win.scrollTo(0, 0);
  };
  win.addEventListener('scroll', pin, { passive: true });
  update();
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  win.addEventListener('resize', schedule);
  win.addEventListener('pageshow', schedule);
  doc.addEventListener('focusin', schedule);
  doc.addEventListener('focusout', schedule);
  return () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    if (guard !== undefined) {
      if (hasTimers) win.clearInterval(guard as number);
      else clearInterval(guard as NodeJS.Timeout);
    }
    viewport.removeEventListener('resize', schedule);
    viewport.removeEventListener('scroll', schedule);
    win.removeEventListener('resize', schedule);
    win.removeEventListener('pageshow', schedule);
    doc.removeEventListener('focusin', schedule);
    doc.removeEventListener('focusout', schedule);
    badge?.remove();
    root.style.removeProperty('--vh');
    root.style.removeProperty('--keyboard-vh');
    root.style.removeProperty('--keyboard-top');
    root.style.removeProperty('--app-h');
    root.classList.remove('ios-shim');
    win.removeEventListener('scroll', pin);
    delete root.dataset.keyboard;
  };
}

/** Live viewport numbers for one screenshot: open any page with `?vh=1`. */
function mountVhBadge(win: Window, doc: Document): { refresh: (editing: boolean) => void; remove: () => void } | null {
  let enabled = false;
  try {
    enabled = new URLSearchParams(win.location?.search ?? '').has('vh');
  } catch {
    enabled = false;
  }
  if (!enabled || typeof doc.createElement !== 'function') return null;
  const el = doc.createElement('div');
  el.setAttribute('data-vh-badge', '1');
  el.style.cssText = 'position:fixed;left:8px;bottom:84px;z-index:9999;pointer-events:none;white-space:pre;font:11px/1.5 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.85);border:1px solid #555;border-radius:8px;padding:6px 8px;';
  // A zero-width probe: what does CSS think 100dvh is right now?
  const probe = doc.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100dvh;visibility:hidden;pointer-events:none;';
  doc.body?.appendChild(probe);
  doc.body?.appendChild(el);
  const standalone =
    (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches) ||
    (win.navigator as Navigator & { standalone?: boolean } | undefined)?.standalone === true;
  const refresh = (editing: boolean) => {
    const inline = doc.documentElement.style.getPropertyValue?.('--vh') || '(css 100dvh)';
    const focus = doc.activeElement as HTMLElement | null;
    el.textContent =
      `vv ${Math.round(win.visualViewport?.height ?? -1)} · lay ${doc.documentElement.clientHeight} · scr ${win.screen?.height ?? -1} · dvh ${probe.clientHeight} · --vh ${inline}\n` +
      `edit ${editing ? 1 : 0} · focus ${focus?.tagName ?? 'none'} · pwa ${standalone ? 1 : 0} · inner ${win.innerHeight} · shim ${doc.documentElement.classList?.contains('ios-shim') ? doc.documentElement.style.getPropertyValue?.('--app-h') : 'off'}`;
  };
  const hasTimers = typeof win.setInterval === 'function' && typeof win.clearInterval === 'function';
  const timer: number | NodeJS.Timeout = hasTimers
    ? win.setInterval(tick, 500)
    : setInterval(tick, 500);
  function tick() {
    const active = doc.activeElement as HTMLElement | null;
    refresh(!!active && !!active.matches?.('textarea, input'));
  }
  const remove = () => {
    if (hasTimers) win.clearInterval(timer as number);
    else clearInterval(timer as NodeJS.Timeout);
    el.remove();
    probe.remove();
  };
  return { refresh, remove };
}

