// Usage's settings (config.json → "usage"): what config.ts parses into, owned here so
// reading the config never loads the usage service (or the database behind it).
import type { Price } from './prices.ts';

export type UsageConfig = {
  retentionDays: number;
  /** Your prices per model id (USD per million tokens), over the built-in list prices. */
  prices: Record<string, Partial<Price>>;
  /** How each provider bills you: `api` (per token), `subscription` (a plan), or `unknown`. */
  billing: Record<string, 'api' | 'subscription' | 'unknown'>;
};

export const DEFAULT_USAGE: UsageConfig = { retentionDays: 400, prices: {}, billing: {} };
