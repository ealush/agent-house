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

export interface ShellViewportInput {
  visualHeight: number;
  visualWidth: number;
  screenWidth: number;
  screenHeight: number;
  scale: number;
  editing: boolean;
  standalone: boolean;
}

// iOS home-screen apps can come up with a viewport that stops a status-bar
// sized band short of the physical screen (seen after launch during a call or
// hotspot banner, and the size then sticks for the life of the app): the page
// canvas still paints to the bottom edge, but the layout viewport, and with it
// the fixed app shell, ends early, leaving a dead strip under the tab bar and
// the composer. Chrome device emulation never reproduces it because it always
// grants the full height. When the signature matches exactly (standalone,
// portrait, unzoomed, not editing, window spanning the full screen width, and
// a shortfall in the status-bar range), size the shell to the screen itself.
export function shellViewportHeight(input: ShellViewportInput): number | null {
  const { visualHeight, visualWidth, screenWidth, screenHeight, scale, editing, standalone } = input;
  if (!standalone || editing) return null;
  if (!Number.isFinite(visualHeight) || !Number.isFinite(screenHeight) || visualHeight <= 0 || screenHeight <= 0) return null;
  if (Math.abs(scale - 1) > 0.05) return null;
  if (Math.abs(visualWidth - screenWidth) > 1) return null;
  const shortfall = screenHeight - visualHeight;
  if (shortfall < 16 || shortfall > 100) return null;
  return screenHeight;
}

export function isStandaloneDisplay(win: Window): boolean {
  try {
    if (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches) return true;
  } catch {
    // Fall through to the iOS-only flag.
  }
  return (win.navigator as Navigator & { standalone?: boolean } | undefined)?.standalone === true;
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
  // Session views). The timer only runs while an override is set.
  let guard: number | NodeJS.Timeout | undefined;
  const badge = mountVhBadge(win, doc);
  const stopGuard = () => {
    if (guard === undefined) return;
    if (hasTimers) win.clearInterval(guard as number);
    else clearInterval(guard as NodeJS.Timeout);
    guard = undefined;
  };
  const startGuard = () => {
    if (guard !== undefined) return;
    guard = hasTimers ? win.setInterval(update, 500) : setInterval(update, 500);
    // Never hold a test runner (or a background tab) open for debug timing.
    (guard as unknown as { unref?: () => void })?.unref?.();
  };
  const update = () => {
    frame = null;
    const active = doc.activeElement as HTMLElement | null;
    const editing = !!active && (active.isContentEditable || active.matches(
      'textarea, input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"])',
    ));
    const height = keyboardViewportHeight(root.clientHeight, viewport.height, viewport.scale, editing);
    // A standalone shell can also come up a status-bar band short of the
    // screen with no keyboard involved; heal that to the full screen height.
    const healed = height === null
      ? shellViewportHeight({
          visualHeight: viewport.height,
          visualWidth: viewport.width,
          screenWidth: win.screen?.width ?? 0,
          screenHeight: win.screen?.height ?? 0,
          scale: viewport.scale,
          editing,
          standalone: isStandaloneDisplay(win),
        })
      : null;
    const appHeight = height ?? healed;
    if (appHeight === null) root.style.removeProperty('--app-h');
    else root.style.setProperty('--app-h', `${appHeight}px`);
    if (height === null && healed === null) {
      root.style.removeProperty('--vh');
      root.style.removeProperty('--keyboard-vh');
      stopGuard();
    } else if (height !== null) {
      root.style.setProperty('--vh', `${height}px`);
      root.style.setProperty('--keyboard-vh', `${height}px`);
      startGuard();
    } else {
      // Healed shell: dialogs and the lock screen size to the same height.
      root.style.setProperty('--vh', `${healed}px`);
      root.style.removeProperty('--keyboard-vh');
      startGuard();
    }
    // iOS can leave the document itself scrolled after a keyboard or a call
    // banner comes and goes, which parks the fixed shell off the visible area.
    // The shell is fixed and nothing legitimately scrolls the document, so
    // snap back whenever we are not editing.
    if (!editing && ((win.scrollY ?? 0) !== 0 || (win.scrollX ?? 0) !== 0)) {
      win.scrollTo(0, 0);
    }
    badge?.refresh(editing);
  };
  // Read fresh dimensions after the browser has applied resize/focus changes.
  const schedule = () => {
    if (frame === null) frame = win.requestAnimationFrame(update);
  };
  update();
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  win.addEventListener('resize', schedule);
  win.addEventListener('scroll', schedule);
  win.addEventListener('pageshow', schedule);
  win.addEventListener('orientationchange', schedule);
  doc.addEventListener('focusin', schedule);
  doc.addEventListener('focusout', schedule);
  return () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    stopGuard();
    viewport.removeEventListener('resize', schedule);
    viewport.removeEventListener('scroll', schedule);
    win.removeEventListener('resize', schedule);
    win.removeEventListener('scroll', schedule);
    win.removeEventListener('pageshow', schedule);
    win.removeEventListener('orientationchange', schedule);
    doc.removeEventListener('focusin', schedule);
    doc.removeEventListener('focusout', schedule);
    badge?.remove();
    root.style.removeProperty('--vh');
    root.style.removeProperty('--keyboard-vh');
    root.style.removeProperty('--app-h');
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
    const appH = doc.documentElement.style.getPropertyValue?.('--app-h') || '(auto)';
    const focus = doc.activeElement as HTMLElement | null;
    el.textContent =
      `vv ${Math.round(win.visualViewport?.height ?? -1)} · lay ${doc.documentElement.clientHeight} · scr ${win.screen?.height ?? -1} · dvh ${probe.clientHeight} · --vh ${inline} · --app-h ${appH}\n` +
      `edit ${editing ? 1 : 0} · focus ${focus?.tagName ?? 'none'} · pwa ${standalone ? 1 : 0}`;
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

