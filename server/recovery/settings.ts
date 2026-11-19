// Recovery's settings (config.json → "recovery"), owned here so reading the config never
// loads the recovery engine (or the database behind it). Off unless you turn it on.

export type RecoveryConfig = { auto: boolean; maxAttempts: number; backoffSeconds: number; maxBackoffSeconds: number; jitterSeconds: number; prompt: string; maxActionsPerMinute: number };

export const DEFAULT_RECOVERY: RecoveryConfig = { auto: false, maxAttempts: 5, backoffSeconds: 60, maxBackoffSeconds: 3600, jitterSeconds: 30, prompt: 'Continue where you left off.', maxActionsPerMinute: 3 };
