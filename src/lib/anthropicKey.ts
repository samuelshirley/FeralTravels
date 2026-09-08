/**
 * Which Anthropic API key this process calls with — resolved in ONE place.
 *
 * There was one key for production, every preview and every laptop, which is
 * why a $15.36 Console bill could not be attributed to anything. Measured over
 * 2026-09-01..08: production's own `usage_events` accounted for $1.31 of it.
 * The rest was CI previews (~$0.51 per full E2E run, in rows that die with the
 * PR's Neon branch) and a `next dev` server on a laptop writing to a throwaway
 * database. Grouping the Console by `api_key_id` could not separate them
 * because there was only ever one id.
 *
 * So: `ANTHROPIC_API_KEY_CI`, when set, wins EXCEPT on production. Everything
 * that is not production — preview deployments, `next dev`, the local iOS
 * runner — bills the second key, and the Console's per-key view becomes the
 * answer to "was that us or a test?" instead of a dead end.
 *
 * WHY THE PRODUCTION EXCLUSION IS THE WHOLE DESIGN, and why this is a function
 * rather than a `??` at four call sites: the failure mode being designed
 * against is `ANTHROPIC_API_KEY_CI` reaching the production environment by
 * accident — a Vercel variable added to "All Environments" is two clicks and
 * the default. If that happened, production would quietly bill the CI key: no
 * error, no failing test, and the one number this exists to separate would be
 * merged again. `VERCEL_ENV === 'production'` is the same signal the account
 * deletion guard and `areTestEndpointsEnabled` already trust, and it is set by
 * the platform, not by us.
 *
 * The alternative — giving `ANTHROPIC_API_KEY` a different VALUE in Vercel's
 * Preview environment — needs no code at all and is a perfectly good answer.
 * It just doesn't cover a developer's laptop, which was a quarter of the spend
 * in the window above.
 */

/** True only on a Vercel production deployment. */
function isProductionRuntime(): boolean {
  return process.env.VERCEL_ENV === 'production';
}

/**
 * The key to construct an `Anthropic` client with, or undefined when none is
 * configured (every caller already treats that as "skip the LLM call").
 *
 * Read at call time, never cached at module scope: the four callers memoise
 * their SDK client, so a value captured on first import would outlive any
 * change and make this untestable.
 */
export function anthropicApiKey(): string | undefined {
  const ci = process.env.ANTHROPIC_API_KEY_CI?.trim();
  if (ci && !isProductionRuntime()) return ci;
  return process.env.ANTHROPIC_API_KEY?.trim() || undefined;
}

/**
 * Whether an Anthropic call is possible at all. Callers used to test
 * `process.env.ANTHROPIC_API_KEY` directly, which would have reported "no key"
 * on a preview configured with only the CI key.
 */
export function hasAnthropicApiKey(): boolean {
  return !!anthropicApiKey();
}
