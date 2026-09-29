import 'server-only';
import { and, eq, gte, sql } from 'drizzle-orm';

import { db } from '@/server/db/client';
import { appMeta, usageEvents, users } from '@/server/db/schema';
import { jevConfigStatus, type JevTierOutcome } from '@/server/jev';

export { MIN_MARGIN as JEV_MIN_MARGIN } from '@/server/jev';
import { CLASSIFY_MODEL } from '@/lib/models';
import { CLASSIFY_MAX_TOKENS } from '@/lib/pennyClassifierPrompt';
import type { MessageTier } from '@/lib/pennyGate';
import { JEV_PROVIDER, microcentsToDollars } from './usage';

/**
 * The Jev switch — global row, per-account override — and Jev's ledger.
 *
 * Every read and write of `app_meta.jev_mode`, `users.jev_mode` and the
 * `provider = 'jev'` rows of `usage_events` goes through this file.
 *
 * ── Both switches fail to OFF ──
 *
 * Copied from `payments/switch.ts`'s paywall switch, for the same reason in a
 * gentler form: OFF is today's behaviour, byte for byte, so a read that failed
 * and answered "off" costs one Haiku call. Anything other than exactly `'on'`
 * or `'off'` is not a value — it is read as the default (global: off; user:
 * follow the global).
 */

export const JEV_META_KEY = 'jev_mode';

export type JevMode = 'on' | 'off';
/** `null` = follow the global switch. */
export type JevOverride = JevMode | null;

/** Where the effective mode came from — recorded on every Jev row. */
export type JevModeSource = 'global' | 'user';

/** Thirty seconds, like the paywall switch: a flip lands while you watch. */
const CACHE_MS = 30_000;
let cached: { value: JevMode; at: number } | null = null;

export function invalidateJevSwitch(): void {
  cached = null;
}

/** Only exactly `'on'` is on. */
export function jevModeFromValue(value: string | null | undefined): JevMode {
  return value === 'on' ? 'on' : 'off';
}

/** Exactly `'on'` or `'off'` overrides; anything else follows the global. */
export function jevOverrideFromValue(value: string | null | undefined): JevOverride {
  return value === 'on' || value === 'off' ? value : null;
}

/** The user's override if set, else the global switch. */
export function resolveJevMode(
  globalMode: JevMode,
  override: JevOverride
): { mode: JevMode; source: JevModeSource } {
  return override === null
    ? { mode: globalMode, source: 'global' }
    : { mode: override, source: 'user' };
}

/** The global switch. FAILS TO OFF, uncached on failure. */
export async function globalJevMode(now = Date.now()): Promise<JevMode> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  try {
    const [row] = await db
      .select({ value: appMeta.value })
      .from(appMeta)
      .where(eq(appMeta.key, JEV_META_KEY))
      .limit(1);
    const value = jevModeFromValue(row?.value);
    cached = { value, at: now };
    return value;
  } catch (err) {
    console.error('[repos/jev] could not read the Jev switch; treating as OFF', err);
    return 'off';
  }
}

/** The only writer of the global row. The route logs who pressed it. */
export async function setGlobalJevMode(mode: JevMode): Promise<void> {
  await db
    .insert(appMeta)
    .values({ key: JEV_META_KEY, value: mode })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: mode } });
  invalidateJevSwitch();
}

/** One account's override. Throws on a failed read — callers decide. */
export async function getUserJevOverride(userId: string): Promise<JevOverride> {
  const [row] = await db
    .select({ jevMode: users.jevMode })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return jevOverrideFromValue(row?.jevMode);
}

/** The only writer of `users.jev_mode`. Returns false when no such account. */
export async function setUserJevOverride(userId: string, override: JevOverride): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ jevMode: override })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return rows.length > 0;
}

/**
 * What the gate asks. NEVER THROWS: any failure is OFF, which is Haiku, which
 * is today.
 */
export async function effectiveJevMode(
  userId: string
): Promise<{ mode: JevMode; source: JevModeSource }> {
  try {
    const [globalMode, override] = await Promise.all([
      globalJevMode(),
      getUserJevOverride(userId),
    ]);
    return resolveJevMode(globalMode, override);
  } catch (err) {
    console.error('[repos/jev] could not resolve the Jev mode; treating as OFF', err);
    return { mode: 'off', source: 'global' };
  }
}

/** How many accounts ignore the global switch, by direction. For /admin. */
export async function countJevOverrides(): Promise<{ on: number; off: number }> {
  const [row] = await db
    .select({
      on: sql<number>`COUNT(*) FILTER (WHERE ${users.jevMode} = 'on')::int`,
      off: sql<number>`COUNT(*) FILTER (WHERE ${users.jevMode} = 'off')::int`,
    })
    .from(users);
  return { on: Number(row?.on ?? 0), off: Number(row?.off ?? 0) };
}

// ── The ledger ──────────────────────────────────────────────────────────────

/**
 * `usage_events.meta` for a Jev row. EXACTLY these keys — built field by field
 * from the outcome rather than spread from it, so nothing the outcome might
 * carry (and certainly not the driver's message) can ride along.
 * `messageGateJev.test.ts` holds that.
 */
export interface JevUsageMeta {
  mode: JevModeSource;
  choice: MessageTier | null;
  top: number | null;
  margin: number | null;
  latencyMs: number | null;
  settled: boolean;
  deferredReason: string | null;
  echoedModel: string | null;
}

export function jevUsageMeta(source: JevModeSource, o: JevTierOutcome): JevUsageMeta {
  const round = (n: number | null) => (n === null ? null : Math.round(n * 10_000) / 10_000);
  return {
    mode: source,
    choice: o.choice,
    top: round(o.top),
    margin: round(o.margin),
    latencyMs: o.latencyMs === null ? null : Math.round(o.latencyMs),
    settled: o.settled,
    deferredReason: o.deferredReason,
    // The backend's own string, capped. Logged, never compared.
    echoedModel: o.echoedModel === null ? null : o.echoedModel.slice(0, 80),
  };
}

/**
 * One row per Jev call: `provider: 'jev'`, cost 0, tokens, success/error,
 * `meta`. Never throws — a bookkeeping failure must not refuse a message.
 */
export async function logJevUsage(input: {
  userId: string;
  tripId: string | null;
  source: JevModeSource;
  outcome: JevTierOutcome;
  model: string | null;
}): Promise<void> {
  const o = input.outcome;
  try {
    await db.insert(usageEvents).values({
      userId: input.userId,
      tripId: input.tripId,
      provider: JEV_PROVIDER,
      model: input.model,
      inputTokens: o.inputTokens,
      outputTokens: o.outputTokens,
      requests: 1,
      costMicrocents: 0,
      success: o.success,
      errorMessage: o.errorMessage === null ? null : o.errorMessage.slice(0, 200),
      meta: jevUsageMeta(input.source, o),
    });
  } catch (err) {
    console.error('[repos/jev] could not record the Jev call', err);
  }
}

// ── /admin ──────────────────────────────────────────────────────────────────

export interface JevConfigView {
  configured: boolean;
  /** Host only — never the key. */
  host: string | null;
  model: string | null;
  t1Min: number | null;
  timeoutMs: number | null;
  keySet: boolean;
  /** Why it is not configured. */
  reason: string | null;
}

export function jevConfigView(): JevConfigView {
  const c = jevConfigStatus();
  if (!c.ok) {
    return { configured: false, host: null, model: null, t1Min: null, timeoutMs: null, keySet: false, reason: c.reason };
  }
  return {
    configured: true,
    host: c.config.host,
    model: c.config.model,
    t1Min: c.config.t1Min,
    timeoutMs: c.config.timeoutMs,
    keySet: c.config.apiKey !== null,
    reason: null,
  };
}

/**
 * The Haiku classifier call's measured cost, used until there are rows to
 * average: decision I11, 50 messages, 2026-09-09.
 */
export const MEASURED_CLASSIFIER_CALL_USD = 0.001352;

export interface JevStats {
  days: number;
  calls: number;
  settled: number;
  /** Every call that did not settle, errors included. */
  passedToHaiku: number;
  errors: number;
  timeouts: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Average cost of one Haiku classifier call, and where it came from. */
  classifierCallUsd: number;
  classifierCallSource: 'usage_events' | 'measured';
  classifierCallRows: number;
  avoidedUsd: number;
}

/**
 * Jev's last N days, for the switch on /admin.
 *
 * "Dollars avoided" is settled × the average Haiku classifier call over the
 * last 30 days. The classifier's `usage_events` rows carry the same model id
 * as Penny's, so they are picked out by SHAPE: `CLASSIFY_MODEL`, output within
 * `CLASSIFY_MAX_TOKENS`, a short uncached input. The onboarding helpers share
 * that shape and are rare; the number is an estimate and says so.
 */
export async function getJevStats(days = 7): Promise<JevStats> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({
      calls: sql<number>`COUNT(*)::int`,
      settled: sql<number>`COUNT(*) FILTER (WHERE ${usageEvents.meta}->>'settled' = 'true')::int`,
      errors: sql<number>`COUNT(*) FILTER (WHERE ${usageEvents.success} = false)::int`,
      timeouts: sql<number>`COUNT(*) FILTER (WHERE ${usageEvents.meta}->>'deferredReason' = 'timeout')::int`,
      p50: sql<number | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY (${usageEvents.meta}->>'latencyMs')::float8)`,
      p95: sql<number | null>`percentile_cont(0.95) WITHIN GROUP (ORDER BY (${usageEvents.meta}->>'latencyMs')::float8)`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.provider, JEV_PROVIDER), gte(usageEvents.createdAt, since)));

  const costSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [cost] = await db
    .select({
      avg: sql<number | null>`AVG(${usageEvents.costMicrocents})::float8`,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.provider, 'anthropic'),
        eq(usageEvents.model, CLASSIFY_MODEL),
        gte(usageEvents.createdAt, costSince),
        sql`${usageEvents.outputTokens} BETWEEN 1 AND ${CLASSIFY_MAX_TOKENS}`,
        sql`${usageEvents.inputTokens} <= 1500`,
        sql`COALESCE(${usageEvents.cacheCreationInputTokens}, 0) = 0`,
        sql`COALESCE(${usageEvents.cacheReadInputTokens}, 0) = 0`
      )
    );

  const calls = Number(row?.calls ?? 0);
  const settled = Number(row?.settled ?? 0);
  const rows = Number(cost?.n ?? 0);
  const fromRows = rows > 0 && cost?.avg !== null && cost?.avg !== undefined;
  const classifierCallUsd = fromRows
    ? microcentsToDollars(Number(cost!.avg))
    : MEASURED_CLASSIFIER_CALL_USD;
  const num = (v: number | null | undefined) =>
    v === null || v === undefined ? null : Math.round(Number(v));

  return {
    days,
    calls,
    settled,
    passedToHaiku: calls - settled,
    errors: Number(row?.errors ?? 0),
    timeouts: Number(row?.timeouts ?? 0),
    p50Ms: num(row?.p50),
    p95Ms: num(row?.p95),
    classifierCallUsd,
    classifierCallSource: fromRows ? 'usage_events' : 'measured',
    classifierCallRows: rows,
    avoidedUsd: settled * classifierCallUsd,
  };
}
