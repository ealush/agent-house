// Checkouts' settings (config.json → "checkouts"): what config.ts parses into, owned
// here so reading the config never loads the Checkouts service or the database.
export type CheckoutsConfig = {
  /** Automatically isolate new writable coding-agent sessions in Git repos into fresh worktrees. */
  autoIsolate: boolean;
  /** Run automatic worktree garbage collection at startup and periodically. */
  gcEnabled: boolean;
  /** How often the background GC sweep runs, in seconds. */
  gcIntervalSeconds: number;
  /** Delete clean, merged, unowned worktrees after this many hours. */
  mergedRetentionHours: number;
  /** Delete clean, unmerged, unowned worktree checkouts after this many days (branch is kept). */
  unmergedRetentionDays: number;
  /** Optional total disk budget in bytes across managed checkouts (null = unlimited). */
  diskBudgetBytes: number | null;
  /** Reclaim eligible clean checkouts immediately when free disk drops below this many bytes (null = disabled). */
  minFreeBytes: number | null;
  /** Contiguous port pool for per-checkout runtime allocation (disjoint from preview.ports). */
  portRange: [number, number];
  /** Number of contiguous ports allocated to each managed checkout. */
  portsPerCheckout: number;
};

export const DEFAULT_CHECKOUTS: CheckoutsConfig = {
  autoIsolate: true,
  gcEnabled: true,
  gcIntervalSeconds: 900,
  mergedRetentionHours: 24,
  unmergedRetentionDays: 7,
  diskBudgetBytes: null,
  minFreeBytes: 2 * 1024 * 1024 * 1024,
  portRange: [41000, 41999],
  portsPerCheckout: 4,
};
