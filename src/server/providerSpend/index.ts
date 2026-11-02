import 'server-only';
import { unstable_cache } from 'next/cache';
import { getAnthropicSpend } from './anthropic';
import { getGoogleSpend, GOOGLE_SPEND_REVALIDATE_S } from './google';

/**
 * Provider-sourced spend: what Anthropic and Google say we owe, as opposed to
 * what our own `usage_events` arithmetic says. The admin dashboard reads money
 * from here and nowhere else (`adminTiles.test.ts` holds the page to it).
 *
 * Caching. Anthropic's read is a GET, cached by Next's data cache through
 * `fetch(..., { next: { revalidate } })` — honoured under `force-dynamic` in
 * Next 14.2, and only HTTP 200s are stored, so an error is never served from
 * cache. Google's is two POSTs, which the fetch cache does not key well, so the
 * whole read sits in `unstable_cache`; it throws on failure, and a throw is not
 * cached either.
 */

export { ANTHROPIC_COST_URL, ANTHROPIC_ADMIN_KEY_ENV } from './anthropic';
export { GOOGLE_BILLING_REPORTS_URL, GOOGLE_BILLING_SA_ENV, GOOGLE_BILLING_TABLE_ENV } from './google';
export type { AnthropicCostData, GoogleBillingData, ProviderSpend } from './types';

export function readAnthropicSpend() {
  return getAnthropicSpend();
}

export function readGoogleSpend() {
  return getGoogleSpend({
    cache: <T,>(key: string, fn: () => Promise<T>) =>
      unstable_cache(fn, ['provider-spend', key], { revalidate: GOOGLE_SPEND_REVALIDATE_S })(),
  });
}
