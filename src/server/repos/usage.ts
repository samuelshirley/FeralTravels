import 'server-only';
import { db } from '@/server/db/client';
import { usageEvents } from '@/server/db/schema';
import { and, eq, gte, sql, desc } from 'drizzle-orm';

// Anthropic public list pricing (USD per 1M tokens). Update when pricing changes.
// https://www.anthropic.com/pricing#anthropic-api
const ANTHROPIC_PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-5':            { input: 3.0,  output: 15.0 },
  'claude-sonnet-4-5-20250929':   { input: 3.0,  output: 15.0 },
  'claude-3-5-sonnet-latest':     { input: 3.0,  output: 15.0 },
  'claude-3-5-sonnet-20241022':   { input: 3.0,  output: 15.0 },
  'claude-3-5-haiku-latest':      { input: 0.8,  output: 4.0 },
  'claude-3-opus-20240229':       { input: 15.0, output: 75.0 },
};

/** Convert US dollars to integer microcents (1 cent = 1,000,000 microcents). */
export function dollarsToMicrocents(usd: number): number {
  return Math.round(usd * 100 * 1_000_000);
}

export function microcentsToDollars(mc: number | null | undefined): number {
  if (!mc) return 0;
  return mc / 100 / 1_000_000;
}

export function estimateAnthropicCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const key = model.toLowerCase();
  const price =
    ANTHROPIC_PRICING_PER_MTOK[key] ??
    Object.entries(ANTHROPIC_PRICING_PER_MTOK).find(([k]) => key.startsWith(k))?.[1];
  if (!price) return 0;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

export interface LogAnthropicUsageInput {
  userId: string;
  tripId?: number | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  success?: boolean;
  errorMessage?: string | null;
}

export async function logAnthropicUsage(input: LogAnthropicUsageInput) {
  const usd = estimateAnthropicCostUsd(input.model, input.inputTokens, input.outputTokens);
  await db.insert(usageEvents).values({
    userId: input.userId,
    tripId: input.tripId ?? null,
    provider: 'anthropic',
    model: input.model,
    inputTokens: input.inputTokens,
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
