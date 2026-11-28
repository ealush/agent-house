// Bringing interrupted sessions back by themselves (server/revive.ts): config.json's `interruptions`.
export type ReviveConfig = {
  /** On unless set false: sessions a tmux stop or a host restart cut off come back by themselves. */
  autoRestore: boolean;
  /** Seconds between two sessions coming back. */
  paceSeconds: number;
  /** This many tmux deaths within `crashWindowMinutes` and ah stops bringing sessions back. */
  maxCrashes: number;
  crashWindowMinutes: number;
  /** Hours an interruption stays to restore before it's forgotten, as if dismissed (0: kept until you act). */
  keepHours: number;
};

export const DEFAULT_REVIVE: ReviveConfig = { autoRestore: true, paceSeconds: 2, maxCrashes: 3, crashWindowMinutes: 10, keepHours: 12 };

/** Settings from config.json's `interruptions`, each one that isn't valid at its default. */
export function reviveConfig(user: Partial<ReviveConfig> | undefined): ReviveConfig {
  const out = { ...DEFAULT_REVIVE };
  if (typeof user?.autoRestore === 'boolean') out.autoRestore = user.autoRestore;
  for (const k of ['paceSeconds', 'maxCrashes', 'crashWindowMinutes', 'keepHours'] as const) {
    const v = user?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

