// What tokens would cost at a provider's API list prices: an estimate, never a bill.
// A subscription plan bills differently (or not per token at all), so every estimate
// says what it's based on, and a model ah has no price for is `unknown`, not zero.
//
// Built in: Anthropic's published list prices, as of 2026-10-06 (USD per million
// tokens). Cache writes are the 5-minute rate (1.25x input); cache reads differ by
// model. Configured prices (`usage.prices` in config) replace these by model id.

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type PriceBasis = 'list_price' | 'configured';

export const LIST_PRICES_AS_OF = '2026-10-06';

const P = (input: number, output: number, cacheRead: number): Price => ({ input, output, cacheRead, cacheWrite: input * 1.25 });

export const LIST_PRICES: Record<string, Price> = {
  'claude-fable-5-1': P(10, 50, 0.25),
  'claude-mythos-5-1': P(10, 50, 0.25),
  'claude-fable-5': P(10, 50, 1),
  'claude-opus-5-5': P(4, 20, 0.2),
  'claude-opus-5': P(5, 25, 0.5),
  'claude-opus-4-8': P(5, 25, 0.5),
  'claude-opus-4-7': P(5, 25, 0.5),
  'claude-opus-4-6': P(5, 25, 0.5),
  'claude-sonnet-5-5': P(2, 10, 0.2),
  'claude-sonnet-5': P(2, 10, 0.2),
  'claude-sonnet-4-6': P(3, 15, 0.3),
  // Prompts up to 100K tokens; past that it's $0.50 / $2.50, which a daily total can't tell apart.
  'claude-haiku-5-5': P(0.1, 0.5, 0.01),
  'claude-haiku-4-5': P(1, 5, 0.1),
};

/** Which provider a model id belongs to, for grouping (not for billing). */
export function providerOf(model: string, harness: string): string {
  const m = model.toLowerCase();
  if (m.startsWith('claude') || harness === 'claude') return 'anthropic';
  if (/^(gpt|o\d|codex)/.test(m) || harness === 'codex') return 'openai';
  if (m.startsWith('gemini') || harness === 'gemini') return 'google';
  if (m.startsWith('grok') || harness === 'grok') return 'xai';
  return 'unknown';
}

/** A dated id ("claude-opus-4-8-20260101") or a 1M-context suffix still names its model. */
function baseId(model: string): string {
  return model.toLowerCase().replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
}

export function priceOf(model: string, configured: Record<string, Partial<Price>> = {}): { price: Price; basis: PriceBasis } | null {
  const id = baseId(model);
  const c = configured[model] ?? configured[id];
  if (c && typeof c.input === 'number' && typeof c.output === 'number') {
    return { price: { input: c.input, output: c.output, cacheRead: c.cacheRead ?? c.input, cacheWrite: c.cacheWrite ?? c.input }, basis: 'configured' };
  }
  const list = LIST_PRICES[id];
  return list ? { price: list, basis: 'list_price' } : null;
}

export type Tokens = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

/** USD at the price given, or null when there's no price to apply. */
export function estimate(t: Tokens, p: { price: Price } | null): number | null {
  if (!p) return null;
  const { price } = p;
  return (t.inputTokens * price.input + t.outputTokens * price.output + t.cacheReadTokens * price.cacheRead + t.cacheWriteTokens * price.cacheWrite) / 1_000_000;
}
