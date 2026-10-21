import 'server-only';
import { db } from '@/server/db/client';
import { usageEvents } from '@/server/db/schema';
import { and, eq, gte, ne, sql, desc } from 'drizzle-orm';
import {
  dollarsToMicrocents,
  estimateAnthropicCostUsd,
  microcentsToDollars,
} from '@/lib/anthropicCostEstimate';

export { dollarsToMicrocents, estimateAnthropicCostUsd, microcentsToDollars };

/**
 * The provider on a Jev call's row. Written by `repos/jev.ts`, at $0 — a
 * self-hosted GPU is a fixed cost — and excluded from every per-user limit:
 * the hourly request count and daily $ cap below, the 12-month cap and trial
 * ceiling (`payments/usage.ts`, `anthropic%` only) and the breakers
 * (`anthropic%` and `penny:gate` only). A Jev call is the gate's own
 * bookkeeping for a message that is already counted once; counting it again
 * would spend the driver's 120/hour on our infrastructure.
 */
export const JEV_PROVIDER = 'jev';

export interface LogAnthropicUsageInput {
  userId: string;
  tripId?: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Tokens billed at 1.25× base input price (prompt-cache writes). */
  cacheCreationInputTokens?: number;
  /** Tokens billed at 0.10× base input price (prompt-cache reads). */
  cacheReadInputTokens?: number;
  success?: boolean;
  errorMessage?: string | null;
}

export async function logAnthropicUsage(input: LogAnthropicUsageInput) {
  const cacheCreate = input.cacheCreationInputTokens ?? 0;
  const cacheRead = input.cacheReadInputTokens ?? 0;
  const usd = estimateAnthropicCostUsd(
    input.model,
    input.inputTokens,
    input.outputTokens,
    cacheCreate,
    cacheRead
  );
  const tokenVolume =
    input.inputTokens + input.outputTokens + cacheCreate + cacheRead;
  if (usd === 0 && tokenVolume > 0) {
    console.warn(
      `[usage] Anthropic cost estimate is $0 despite ${tokenVolume} tokens — add pricing for model "${input.model}" in anthropicCostEstimate.ts`
    );
  }
  // Store regular input, cache-write, and cache-read token counts in separate
  // columns so cache hit rate is recoverable per row. inputTokens is the pure
  // regular-input count (NOT cache tokens summed in). The costMicrocents field
  // already reflects the correctly-discounted USD across all three.
  await db.insert(usageEvents).values({
    userId: input.userId,
    tripId: input.tripId ?? null,
    provider: 'anthropic',
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheCreationInputTokens: cacheCreate,
    cacheReadInputTokens: cacheRead,
    requests: 1,
    costMicrocents: dollarsToMicrocents(usd),
    success: input.success ?? true,
    errorMessage: input.errorMessage ?? null,
  });
}

/**
 * Like `logAnthropicUsage`, but never throws. On DB failure, logs loudly and
 * writes `provider: anthropic:accounting-write-failed` so admin can correlate.
 * Returns whether the primary `anthropic` row was inserted successfully.
 */
export async function logAnthropicUsageWithFallback(
  input: LogAnthropicUsageInput
): Promise<boolean> {
  try {
    await logAnthropicUsage(input);
    return true;
  } catch (err) {
    console.error('[usage] logAnthropicUsage failed', {
      userId: input.userId,
      tripId: input.tripId,
      accountingSuccessFlag: input.success ?? true,
      err,
    });
    await logUsageEvent({
      userId: input.userId,
      tripId: input.tripId,
      provider: 'anthropic:accounting-write-failed',
      requests: 1,
      success: false,
      errorMessage: [
        input.errorMessage ?? null,
        err instanceof Error ? err.message : String(err),
      ]
        .filter(Boolean)
        .join(' | ')
        .slice(0, 500),
    }).catch((e) => console.error('[usage] logUsageEvent (accounting fallback) failed:', e));
    return false;
  }
}

export async function logUsageEvent(input: {
  userId?: string | null;
  tripId?: string | null;
  provider: string;
  /**
   * The sub-kind within a provider. Used as the SKU for `google-places` rows
   * and as the tier for `penny:gate` rows — which is what the
   * `gated_messages_1h` circuit breaker counts, so the smoke detector and the
   * record are the same rows rather than two things that can disagree.
   */
  model?: string | null;
  requests?: number;
  success?: boolean;
  errorMessage?: string | null;
}) {
  await db.insert(usageEvents).values({
    userId: input.userId ?? null,
    tripId: input.tripId ?? null,
    provider: input.provider,
    model: input.model ?? null,
    requests: input.requests ?? 1,
    success: input.success ?? true,
    errorMessage: input.errorMessage ?? null,
  });
}

// Google Places API (New) per-call list price in USD, keyed by the SKU stored
// in `usage_events.model`. Both callers of `places:searchText` — Finn's
// along-route station search and the name→coords geocode — bill as Text Search
// Pro, so they share this one row. Nearby Search is not called anywhere.
// Checked against Google's price page 2026-10-06; update when it changes.
// https://developers.google.com/maps/billing-and-pricing/pricing
const GOOGLE_PLACES_PRICING_PER_CALL_USD: Record<string, number> = {
  'text-search': 0.032,
};

export type GooglePlacesEndpoint = 'text-search';

/**
 * Per-SKU monthly free-call allowance (Google gives each SKU its own, not a
 * shared credit). Subtracted from the calendar-month call count when the admin
 * dashboard shows "billable" Google spend. The allowance is per SKU, so Finn
 * and the geocoder draw on the same 5,000.
 *
 * Directions is logged per call (`logGoogleApiUsage`) but its free tier is not
 * subtracted; Maps JavaScript loads are not logged at all. Cross-check against
 * Google Cloud Console → Billing → Reports.
 */
export const GOOGLE_PLACES_FREE_CALLS_PER_MONTH: Record<GooglePlacesEndpoint, number> = {
  'text-search': Number(
    process.env.GOOGLE_PLACES_FREE_CALLS_TEXT_SEARCH_PER_MONTH ?? 5000
  ),
};

export interface LogGooglePlacesUsageInput {
  /**
   * Null when the caller does not know the user. Never `''`: `user_id` is a
   * foreign key to `users`, so an empty string fails the insert and the row is
   * lost (the caller's `record` swallows the error).
   */
  userId: string | null;
  tripId?: string | null;
  endpoint: GooglePlacesEndpoint;
  /** How many Places calls this row covers — usually batched per leg/replan. */
  requests: number;
  success?: boolean;
  errorMessage?: string | null;
}

/**
 * Record Google Places usage so it appears alongside Anthropic spend in
 * usageEvents / admin dashboards. Cost is the list price of the SKU passed in
 * `endpoint`; the request count is what actually hit Google.
 *
 * No-op when `requests <= 0` so we don't write empty rows from legs that
 * skipped planning.
 */
export async function logGooglePlacesUsage(input: LogGooglePlacesUsageInput) {
  if (input.requests <= 0) return;
  const perCall = GOOGLE_PLACES_PRICING_PER_CALL_USD[input.endpoint] ?? 0.032;
  const usd = perCall * input.requests;
  await db.insert(usageEvents).values({
    userId: input.userId,
    tripId: input.tripId ?? null,
    provider: 'google-places',
    model: input.endpoint,
    inputTokens: 0,
    outputTokens: 0,
    requests: input.requests,
    costMicrocents: dollarsToMicrocents(usd),
    success: input.success ?? true,
    errorMessage: input.errorMessage ?? null,
  });
}

/**
 * Per-call USD for Directions, the one non-Places Google API the server calls.
 * Our estimate from Google's price page, not a bill, and its free allowance is
 * not subtracted here. More than 10 waypoints bills as Directions Advanced.
 */
const GOOGLE_DIRECTIONS_PER_CALL_USD = 0.005;
const GOOGLE_DIRECTIONS_ADVANCED_PER_CALL_USD = 0.010;
const GOOGLE_DIRECTIONS_ADVANCED_ABOVE_WAYPOINTS = 10;

/**
 * Record one call to Google Directions.
 *
 * Exists because `logGooglePlacesUsage` had NO caller between 2026-06-29 and
 * 2026-09-09 and Directions never had one at all — so the app's entire Google
 * spend was invisible in `usage_events` while CLAUDE.md was simultaneously
 * claiming those calls were free. Counting them is what makes that claim
 * checkable. (Rows with provider `google-geocode` predate 2026-10-07, when the
 * geocoder moved to the `text-search` Places SKU it actually bills as.)
 */
export async function logGoogleApiUsage(input: {
  provider: 'google-directions';
  userId?: string | null;
  tripId?: string | null;
  requests?: number;
  /** Waypoints on the request; more than 10 is the dearer Advanced SKU. */
  waypoints?: number;
  success?: boolean;
  errorMessage?: string | null;
}) {
  const requests = input.requests ?? 1;
  if (requests <= 0) return;
  const perCall =
    (input.waypoints ?? 0) > GOOGLE_DIRECTIONS_ADVANCED_ABOVE_WAYPOINTS
      ? GOOGLE_DIRECTIONS_ADVANCED_PER_CALL_USD
      : GOOGLE_DIRECTIONS_PER_CALL_USD;
  const usd = perCall * requests;
  await db.insert(usageEvents).values({
    userId: input.userId ?? null,
    tripId: input.tripId ?? null,
    provider: input.provider,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    requests,
    costMicrocents: dollarsToMicrocents(usd),
    success: input.success ?? true,
    errorMessage: input.errorMessage ?? null,
  });
}

/** Sum cost + count requests for a user in the trailing N hours. Used for rate limiting. */
export async function getUserUsageSummary(userId: string, hours: number) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await db
    .select({
      requests: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)`,
      microcents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)`,
      inputTokens: sql<number>`COALESCE(SUM(${usageEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, userId),
        gte(usageEvents.createdAt, since),
        // Jev rows never count toward the caps — see JEV_PROVIDER.
        ne(usageEvents.provider, JEV_PROVIDER)
      )
    );
  return rows[0] ?? { requests: 0, microcents: 0, inputTokens: 0, outputTokens: 0 };
}

/** Aggregate usage across all users — used by the admin dashboard. */
export async function getGlobalUsage(hours: number) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await db
    .select({
      provider: usageEvents.provider,
      requests: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)`,
      microcents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)`,
      inputTokens: sql<number>`COALESCE(SUM(${usageEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)`,
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since))
    .groupBy(usageEvents.provider);
  return rows;
}

/**
 * Compute Google Maps "actual billable" spend for the current calendar month
 * (UTC) by subtracting each SKU's free-call allowance from its month-to-date
 * call count, then multiplying the remainder by the per-call list price.
 *
 * Why a separate calc instead of summing `costMicrocents`? `logGooglePlacesUsage`
 * stores the GROSS estimate (per-call price × calls) per row. The free tier
 * resets monthly across all rows, so it can only be applied at aggregate time —
 * not per-event. This function does that aggregation.
 *
 * Returned shape supports both a headline "Google billable (mo)" stat card and
 * a per-SKU breakdown row.
 */
export interface GoogleBillableSummary {
  grossUsd: number;
  billableUsd: number;
  perSku: Array<{
    sku: string;
    calls: number;
    freeCalls: number;
    grossUsd: number;
    billableUsd: number;
  }>;
}

export async function getGoogleBillableThisMonth(): Promise<GoogleBillableSummary> {
  // Defensive: any DB hiccup here should not 500 the whole admin dashboard.
  // The dashboard has many other panels; if Google billing math fails we
  // render zeros + log the error and let the user see everything else.
  try {
    const now = new Date();
    const startOfMonthUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    );

    const rows = await db
      .select({
        sku: usageEvents.model,
        calls: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)::int`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.provider, 'google-places'),
          gte(usageEvents.createdAt, startOfMonthUtc)
        )
      )
      .groupBy(usageEvents.model);

    const perSku = rows.map((r) => {
      const sku = r.sku ?? 'unknown';
      const calls = Number(r.calls) || 0;
      const perCall = GOOGLE_PLACES_PRICING_PER_CALL_USD[sku] ?? 0;
      const freeCalls =
        GOOGLE_PLACES_FREE_CALLS_PER_MONTH[sku as GooglePlacesEndpoint] ?? 0;
      const billableCalls = Math.max(0, calls - freeCalls);
      return {
        sku,
        calls,
        freeCalls,
        grossUsd: calls * perCall,
        billableUsd: billableCalls * perCall,
      };
    });

    const grossUsd = perSku.reduce((s, r) => s + r.grossUsd, 0);
    const billableUsd = perSku.reduce((s, r) => s + r.billableUsd, 0);

    return { grossUsd, billableUsd, perSku };
  } catch (err) {
    console.error('[admin] getGoogleBillableThisMonth failed:', err);
    return { grossUsd: 0, billableUsd: 0, perSku: [] };
  }
}

/** Per-user usage breakdown for the trailing window — admin dashboard. */
export async function getUsageByUser(hours: number, limit = 50) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await db
    .select({
      userId: usageEvents.userId,
      requests: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)`,
      microcents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)`,
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since))
    .groupBy(usageEvents.userId)
    .orderBy(desc(sql`SUM(${usageEvents.costMicrocents})`))
    .limit(limit);
  return rows;
}
