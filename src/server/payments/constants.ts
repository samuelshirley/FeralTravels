/**
 * Every number the paywall depends on, in one file, with the reasoning that
 * produced it. Changing one of these changes the unit economics — re-run
 * `npx tsx scripts/lifetime-spend.ts` before you do, the way
 * docs/design/subscriptions.md was written.
 *
 * Deliberately free of `server-only` and of any DB import: the pure resolver
 * and its unit tests read these without booting a database.
 */

/** Free days from sign-up. The gate is `now > users.created_at + TRIAL_DAYS`. */
export const TRIAL_DAYS = 7;

/** 1¢ = 1_000_000 microcents, so $1 = 1e8. Same convention as `usage_events`. */
export const MICROCENTS_PER_DOLLAR = 100_000_000;

export function dollars(n: number): number {
  return Math.round(n * MICROCENTS_PER_DOLLAR);
}

/**
 * Trial ceiling: $1 of Anthropic spend, or seven days, whichever comes first.
 *
 * Seven days alone is a weak bound — at roughly $0.12 per LLM call a
 * determined account could burn $50 inside the week. $1 is about three trips
 * at observed rates: a genuine taste, and a hard floor on what a non-paying
 * account can cost us.
 */
export const TRIAL_CEILING_MICROCENTS = dollars(1);

/**
 * Admin alert only. Nothing user-visible. $2 is five times the heaviest real
 * user's three-month spend — historically it catches only the dev and CI
 * accounts, which is exactly what an early warning should do.
 */
export const WATCH_MICROCENTS = dollars(2);

/**
 * Soft block. $8.50 is 50% of annual net revenue ($17.00 after Apple's 15%),
 * the point where the unit economics stop working.
 *
 * This threshold is so far above real usage that by the time it fires, per-trip
 * cost has almost certainly regressed — which is why the alert email is worded
 * as an efficiency signal rather than an accusation.
 */
export const STOP_MICROCENTS = dollars(8.5);

/** Both thresholds are measured over a rolling 12 months, not a calendar month. */
export const CAP_WINDOW_DAYS = 365;

/**
 * The two products, priced in whole dollars on purpose.
 *
 * Apple's December 2022 pricing overhaul added 700+ price points including
 * ones that do not end in .99, so $2.00 and $20.00 are both selectable in App
 * Store Connect. The annual is cheaper than 12× monthly ($20.00 vs $24.00) —
 * the normal discount for paying up front.
 *
 * `priceLabel` is what the purchase sheet renders when the store is
 * unreachable. Once StoreKit is live the sheet shows the store's own localized
 * price string instead, because these strings are wrong in every currency but
 * USD. See docs/design/revenuecat-implementation.md.
 */
export const PRODUCTS = [
  {
    id: 'com.feraltravels.ios.monthly',
    period: 'month',
    priceUsd: 2,
    priceLabel: '$2',
    cadence: 'per month',
  },
  {
    id: 'com.feraltravels.ios.annual',
    period: 'year',
    priceUsd: 20,
    priceLabel: '$20',
    cadence: 'per year',
  },
] as const;

export type ProductId = (typeof PRODUCTS)[number]['id'];

export function isProductId(v: string): v is ProductId {
  return PRODUCTS.some((p) => p.id === v);
}

export function productById(id: ProductId) {
  return PRODUCTS.find((p) => p.id === id)!;
}
