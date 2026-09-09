/**
 * Every number the paywall depends on, in one file, with the reasoning that
 * produced it. Changing one of these changes the unit economics — re-run
 * `npx tsx scripts/lifetime-spend.ts` before you do, the way
 * docs/design/subscriptions.md was written.
 *
 * Deliberately free of `server-only` and of any DB import: the pure resolver
 * and its unit tests read these without booting a database.
 */

import type { BreakerSpec } from './breakers';

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

// ── Circuit breakers ────────────────────────────────────────────────────────

/**
 * The global ceiling on what the whole app may spend, and how fast it may grow.
 *
 * These are the only numbers that bound the bill. Every other limit in the
 * codebase is per-account, and an attacker chooses how many accounts they have
 * — a hundred bots at the existing $5/day cap is $500 overnight with every
 * gate passing. So the worst case of any attack is meant to be arithmetic:
 * `MAX OVERNIGHT LOSS = the 24h stop + one cache window per running instance`.
 *
 * Sized against what the app actually costs, measured rather than guessed:
 *
 *  - A Penny planning turn on Haiku is ~$0.085 (the Austin 14-leg trip,
 *    2026-09-09; the same turn was $0.585 on Sonnet). Real accounts have
 *    historically cost about $0.29 a trip.
 *  - The whole of production billed $21.94 across 2026-09-01..08 — for EIGHT
 *    DAYS, across the app, CI and a laptop. So $25 in a single day is already
 *    an unprecedented event, not a busy Tuesday.
 *  - The alert lines sit at roughly 40% of the stops, which on those figures
 *    is "something is happening that has never happened" rather than "someone
 *    is planning a big trip".
 *
 * The 1-hour breakers exist because the 24-hour one is too slow to be a
 * defence on its own: $25 can be spent in fifteen minutes, and a limit that
 * only notices the next morning has not stopped anything.
 *
 * Raising these is a deliberate act. If real traffic starts tripping them, the
 * fix is usually not a bigger number — it is finding out what is costing that
 * much, which `toolTrace` and `scripts/anthropic-usage-report.ts` are for.
 */
export const BREAKERS: readonly BreakerSpec[] = [
  {
    id: 'anthropic_spend_24h',
    gate: 'penny',
    unit: 'microcents',
    windowHours: 24,
    alertAt: dollars(10),
    stopAt: dollars(25),
    label: 'Anthropic spend, all users, 24h',
  },
  {
    id: 'anthropic_spend_1h',
    gate: 'penny',
    unit: 'microcents',
    windowHours: 1,
    alertAt: dollars(3),
    stopAt: dollars(8),
    label: 'Anthropic spend, all users, 1h',
  },
  {
    /**
     * The manual stop. No threshold to cross — the owner throws it from
     * `/admin` (or a phone) and Penny goes quiet for everyone but the admin,
     * with no deploy. It is in the same list as the measured breakers so that
     * one evaluation answers "may this proceed", one banner shows the state,
     * and one 503 shape covers every reason.
     */
    id: 'manual_lock',
    gate: 'penny',
    unit: 'count',
    windowHours: 0,
    alertAt: 1,
    stopAt: 1,
    label: 'Penny locked by hand',
  },
  {
    id: 'signups_1h',
    gate: 'signup',
    unit: 'count',
    windowHours: 1,
    alertAt: 50,
    stopAt: 100,
    label: 'New accounts, 1h',
  },
  {
    id: 'signups_24h',
    gate: 'signup',
    unit: 'count',
    windowHours: 24,
    alertAt: 100,
    stopAt: 200,
    label: 'New accounts, 24h',
  },
  {
    /**
     * ALERT ONLY, on purpose. A hundred junk messages in an hour is worth
     * waking up for, but stopping on it would punish the wrong people: the
     * tier gate has already refused each of those messages for $0, and the
     * things that should actually stop an abuser are the per-IP limits and the
     * strike lock, which are aimed at the abuser rather than at everybody.
     */
    id: 'gated_messages_1h',
    gate: 'penny',
    unit: 'count',
    windowHours: 1,
    alertAt: 100,
    stopAt: null,
    label: 'Gated (junk) messages, 1h',
  },
] as const;

/**
 * How stale a breaker reading may be.
 *
 * The gate runs on EVERY Penny turn and every OTP send, so an uncached read is
 * a query per request forever. Thirty seconds, matching the paywall switch,
 * and the bound it buys is worth stating because it is the second term in the
 * loss arithmetic above: an instance that read "closed" one second ago will go
 * on serving for up to thirty more, and Vercel runs several instances. The
 * true worst case is therefore the stop line plus thirty seconds of spend per
 * running instance — which at Haiku rates is single-digit dollars, and is the
 * price of not adding a database read to every request.
 */
export const BREAKER_CACHE_MS = 30_000;

// ── Per-account daily spend caps ────────────────────────────────────────────

/**
 * What one SUBSCRIBER may spend on Anthropic in a rolling day.
 *
 * Generous on purpose: a paying driver replanning a fortnight in Norway on a
 * bad evening should never meet this, and at Haiku rates ($0.085 a planning
 * turn) $5 is around sixty turns. It is a runaway-cost backstop, not a budget.
 */
export const REPLAN_USD_CAP_PER_DAY = 5;

/**
 * What a TRIAL account may spend in a rolling day.
 *
 * Ten times lower, because the money is asymmetric in a way the old single cap
 * ignored: a subscriber has paid $2 or $20 and their spend is an argument about
 * margin, while a trial account has paid nothing and 100 of them at $5 is $500
 * of pure loss — which is the number this whole feature exists for.
 *
 * $0.50 is about six planning turns a day, which is more than enough to decide
 * whether the app is any good; the trial's real ceiling is
 * `TRIAL_CEILING_MICROCENTS` ($1 total), so this is the daily shape of that
 * same dollar rather than a second, competing limit.
 */
export const TRIAL_REPLAN_USD_CAP_PER_DAY = 0.5;
