import { useSyncExternalStore } from 'react';
import { getMode, getResolved, subscribeTheme, type ResolvedTheme, type ThemeMode } from './theme.ts';

/** Reactive theme state for components; the values live in theme.ts. */
export function useTheme(): { mode: ThemeMode; resolved: ResolvedTheme } {
  const mode = useSyncExternalStore(
    (fn) => subscribeTheme(() => fn()),
    getMode,
    getMode,
  );
  const resolved = useSyncExternalStore(
    (fn) => subscribeTheme(() => fn()),
    getResolved,
    getResolved,
  );
  return { mode, resolved };
}
