/**
 * Shared Anthropic list-price estimates (USD). Used by usage logging and by
 * offline scripts (backfill / reconcile) — must stay free of `server-only`.
 *
 * https://www.anthropic.com/pricing#anthropic-api
 */
const ANTHROPIC_PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  // Explicit dated ids (prefix matcher also covers these)
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-sonnet-4': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
  'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku': { input: 0.8, output: 4.0 },
  'claude-haiku-4': { input: 0.8, output: 4.0 },
  'claude-3-opus': { input: 15.0, output: 75.0 },
  'claude-opus-4': { input: 15.0, output: 75.0 },
};

/** Convert US dollars to integer microcents (1 cent = 1,000,000 microcents). */
export function dollarsToMicrocents(usd: number): number {
  return Math.round(usd * 100 * 1_000_000);
}

export function microcentsToDollars(mc: number | null | undefined): number {
  if (!mc) return 0;
  return mc / 100 / 1_000_000;
}

/**
 * Anthropic prompt-cache pricing modifiers (relative to base input price):
 *   - cache write (cache_creation_input_tokens): 1.25× base
 *   - cache read  (cache_read_input_tokens):     0.10× base
 * https://docs.claude.com/en/docs/build-with-claude/prompt-caching
 */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Longest-prefix wins so `claude-sonnet-4-5-*` matches `claude-sonnet-4-5`
 * before the shorter `claude-sonnet-4` prefix.
 */
export function estimateAnthropicCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0
): number {
  const key = model.toLowerCase();
  const price =
    ANTHROPIC_PRICING_PER_MTOK[key] ??
    [...Object.entries(ANTHROPIC_PRICING_PER_MTOK)]
      .sort((a, b) => b[0].length - a[0].length)
      .find(([k]) => key.startsWith(k))?.[1];
  if (!price) return 0;
  const inputCost = (inputTokens / 1_000_000) * price.input;
  const cacheWriteCost =
    (cacheCreationInputTokens / 1_000_000) * price.input * CACHE_WRITE_MULTIPLIER;
  const cacheReadCost =
    (cacheReadInputTokens / 1_000_000) * price.input * CACHE_READ_MULTIPLIER;
  const outputCost = (outputTokens / 1_000_000) * price.output;
  return inputCost + cacheWriteCost + cacheReadCost + outputCost;
}
