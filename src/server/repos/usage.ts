import 'server-only';
import { db } from '@/server/db/client';
import { usageEvents } from '@/server/db/schema';
import { and, eq, gte, sql, desc } from 'drizzle-orm';

// Anthropic public list pricing (USD per 1M tokens). Update when pricing changes.
// https://www.anthropic.com/pricing#anthropic-api
const ANTHROPIC_PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  // Sonnet 4 (current Penny model: claude-sonnet-4-20250514)
  'claude-sonnet-4':              { input: 3.0,  output: 15.0 },
  // Sonnet 4.5
  'claude-sonnet-4-5':            { input: 3.0,  output: 15.0 },
  // Legacy Sonnet 3.5
  'claude-3-5-sonnet':            { input: 3.0,  output: 15.0 },
  // Haiku
  'claude-3-5-haiku':             { input: 0.8,  output: 4.0 },
  'claude-haiku-4':               { input: 0.8,  output: 4.0 },
  // Opus
  'claude-3-opus':                { input: 15.0, output: 75.0 },
  'claude-opus-4':                { input: 15.0, output: 75.0 },
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
    Object.entries(ANTHROPIC_PRICING_PER_MTOK).find(([k]) => key.startsWith(k))?.[1];
  if (!price) return 0;
  // Anthropic's `input_tokens` field excludes cache reads/writes — they're
  // billed separately, so we add each component at its own rate.
  const inputCost = (inputTokens / 1_000_000) * price.input;
  const cacheWriteCost =
    (cacheCreationInputTokens / 1_000_000) * price.input * CACHE_WRITE_MULTIPLIER;
  const cacheReadCost =
    (cacheReadInputTokens / 1_000_000) * price.input * CACHE_READ_MULTIPLIER;
  const outputCost = (outputTokens / 1_000_000) * price.output;
  return inputCost + cacheWriteCost + cacheReadCost + outputCost;
}

export interface LogAnthropicUsageInput {
  userId: string;
  tripId?: number | null;
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
  // Roll cache tokens into the stored inputTokens column so the dashboard
  // reflects total token volume (regular + cache write + cache read). The
  // costMicrocents field already reflects the correctly-discounted USD.
  await db.insert(usageEvents).values({
    userId: input.userId,
    tripId: input.tripId ?? null,
    provider: 'anthropic',
    model: input.model,
    inputTokens: input.inputTokens + cacheCreate + cacheRead,
    outputTokens: input.outputTokens,
    requests: 1,
    costMicrocents: dollarsToMicrocents(usd),
    success: input.success ?? true,
    errorMessage: input.errorMessage ?? null,
  });
}

export async function logUsageEvent(input: {
  userId?: string | null;
  tripId?: number | null;
  provider: string;
  requests?: number;
  success?: boolean;
  errorMessage?: string | null;
}) {
  await db.insert(usageEvents).values({
    userId: input.userId ?? null,
    tripId: input.tripId ?? null,
    provider: input.provider,
    requests: input.requests ?? 1,
    success: input.success ?? true,
    errorMessage: input.errorMessage ?? null,
  });
}

// Google Places API (New) per-call pricing in USD. Tied to which fields we
// request via X-Goog-FieldMask:
//   - "essentials"  → only id, displayName, location, primaryType (~$0.005)
//   - "pro"         → adds googleMapsUri or other Pro-tier fields  (~$0.025)
//   - "enterprise"  → reviews, contact info, etc. (not used here)  (~$0.040)
// We pick the SKU at the call site so the bill estimate matches what we
// asked Google for. Update when Google's price page changes.
// https://developers.google.com/maps/billing-and-pricing/pricing
const GOOGLE_PLACES_PRICING_PER_CALL_USD: Record<string, number> = {
  'nearby-search-essentials': 0.005,
  'nearby-search-pro': 0.025,
  'nearby-search-enterprise': 0.040,
};

export type GooglePlacesEndpoint =
  | 'nearby-search-essentials'
  | 'nearby-search-pro'
  | 'nearby-search-enterprise';

/**
 * Per-SKU monthly free-call allowance from Google Maps Platform's free tier.
 * Each SKU has its own monthly allowance (NOT a shared $200 credit anymore as
 * of 2024-2025). We subtract these from the calendar-month call counts when
 * rendering "billable" Google spend on the admin dashboard.
 *
 * Defaults reflect the Maps Platform free tier as of late 2024 — Google
 * updates these periodically, so they're env-configurable. Verify against
 * https://developers.google.com/maps/billing-and-pricing/pricing and your
 * own Google Cloud Console → Billing → Reports view.
 */
export const GOOGLE_PLACES_FREE_CALLS_PER_MONTH: Record<GooglePlacesEndpoint, number> = {
  'nearby-search-essentials': Number(
    process.env.GOOGLE_PLACES_FREE_CALLS_ESSENTIALS_PER_MONTH ?? 10000
  ),
  'nearby-search-pro': Number(
    process.env.GOOGLE_PLACES_FREE_CALLS_PRO_PER_MONTH ?? 5000
  ),
  'nearby-search-enterprise': Number(
    process.env.GOOGLE_PLACES_FREE_CALLS_ENTERPRISE_PER_MONTH ?? 1000
  ),
};

export interface LogGooglePlacesUsageInput {
  userId: string;
  tripId?: number | null;
  endpoint: GooglePlacesEndpoint;
  /** How many Places calls this row covers — usually batched per leg/replan. */
  requests: number;
  success?: boolean;
  errorMessage?: string | null;
}

/**
 * Record Google Places usage so it appears alongside Anthropic spend in
 * usageEvents / admin dashboards. Costs are estimated from the field-mask
 * tier passed in `endpoint`; the request count is what actually hit Google.
 *
 * No-op when `requests <= 0` so we don't write empty rows from legs that
 * skipped planning.
 */
export async function logGooglePlacesUsage(input: LogGooglePlacesUsageInput) {
  if (input.requests <= 0) return;
  const perCall = GOOGLE_PLACES_PRICING_PER_CALL_USD[input.endpoint] ?? 0.005;
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
    .where(and(eq(usageEvents.userId, userId), gte(usageEvents.createdAt, since)));
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
export async function getGoogleBillableThisMonth(): Promise<{
  grossUsd: number;
  billableUsd: number;
  perSku: Array<{
    sku: string;
    calls: number;
    freeCalls: number;
    grossUsd: number;
    billableUsd: number;
  }>;
}> {
  const now = new Date();
  const startOfMonthUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

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
