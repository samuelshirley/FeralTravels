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
 * and answered "off" costs one Haiku call. Anything other than exactly `'on'`,
 * `'compare'` or `'off'` is not a value — it is read as the default (global:
 * off; user: follow the global).
 *
 * ── Three modes ──
 *
 *  - `'off'`: Haiku only. No network call to Jev.
 *  - `'compare'`: Haiku decides every message exactly as `'off'`; Jev is asked
 *    the same question alongside and its answer is only LOGGED, beside
 *    Haiku's, so /admin can say whether Jev-first would be safe.
 *  - `'on'`: Jev first; it may settle a confident T1, else Haiku.
 */

export const JEV_META_KEY = 'jev_mode';

export const JEV_MODES = ['off', 'compare', 'on'] as const;
export type JevMode = (typeof JEV_MODES)[number];
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

function isJevMode(value: string | null | undefined): value is JevMode {
  return (JEV_MODES as readonly string[]).includes(value as string);
}

/** Exactly `'on'` or `'compare'`; anything else is OFF. */
export function jevModeFromValue(value: string | null | undefined): JevMode {
  return isJevMode(value) ? value : 'off';
}

/** Exactly `'on'`, `'compare'` or `'off'` overrides; anything else follows the global. */
export function jevOverrideFromValue(value: string | null | undefined): JevOverride {
  return isJevMode(value) ? value : null;
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

/** How many accounts ignore the global switch, by mode. For /admin. */
export async function countJevOverrides(): Promise<Record<JevMode, number>> {
  const [row] = await db
    .select({
      on: sql<number>`COUNT(*) FILTER (WHERE ${users.jevMode} = 'on')::int`,
      compare: sql<number>`COUNT(*) FILTER (WHERE ${users.jevMode} = 'compare')::int`,
      off: sql<number>`COUNT(*) FILTER (WHERE ${users.jevMode} = 'off')::int`,
    })
    .from(users);
  return {
    on: Number(row?.on ?? 0),
    compare: Number(row?.compare ?? 0),
    off: Number(row?.off ?? 0),
  };
}

// ── The ledger ──────────────────────────────────────────────────────────────

/**
 * `usage_events.meta` for a Jev-first row. EXACTLY these keys — built field by
 * field from the outcome rather than spread from it, so nothing the outcome
 * might carry (and certainly not the driver's message) can ride along.
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
 * `usage_events.meta` for a compare-mode row: Jev's answer beside Haiku's.
 * Same key-by-key rule as `jevUsageMeta`, and never user text.
 *
 * `settled` is always false — in compare mode Jev settles nothing.
 * `wouldSettle` is whether the Jev-first rule (`settlesAsT1`) would have let
 * this message through without Haiku. `agree` is Jev's CHOICE against Haiku's
 * TIER, false when Jev gave no answer.
 */
export interface JevCompareMeta {
  mode: 'compare';
  source: JevModeSource;
  choice: MessageTier | null;
  top: number | null;
  margin: number | null;
  latencyMs: number | null;
  settled: false;
  wouldSettle: boolean;
  haikuTier: MessageTier;
  agree: boolean;
  deferredReason: string | null;
  echoedModel: string | null;
}

export function jevCompareMeta(
  source: JevModeSource,
  o: JevTierOutcome,
  haikuTier: MessageTier
): JevCompareMeta {
  const m = jevUsageMeta(source, o);
  return {
    mode: 'compare',
    source,
    choice: m.choice,
    top: m.top,
    margin: m.margin,
    latencyMs: m.latencyMs,
    settled: false,
    wouldSettle: o.settled,
    haikuTier,
    agree: o.choice !== null && o.choice === haikuTier,
    deferredReason: m.deferredReason,
    echoedModel: m.echoedModel,
  };
}

/**
 * One row per Jev call: `provider: 'jev'`, cost 0, tokens, success/error,
 * `meta`. `compare` set = a compare-mode row, carrying Haiku's tier.
 * Never throws — a bookkeeping failure must not refuse a message.
 */
export async function logJevUsage(input: {
  userId: string;
  tripId: string | null;
  source: JevModeSource;
  outcome: JevTierOutcome;
  model: string | null;
  compare?: { haikuTier: MessageTier };
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
      meta: input.compare
        ? jevCompareMeta(input.source, o, input.compare.haikuTier)
        : jevUsageMeta(input.source, o),
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

/** Compare-mode rows carry `meta.mode = 'compare'`; Jev-first rows carry the source. */
const isCompareRow = sql`${usageEvents.meta}->>'mode' = 'compare'`;
const isJevFirstRow = sql`COALESCE(${usageEvents.meta}->>'mode', '') <> 'compare'`;

/**
 * Jev-first's last N days, for the switch on /admin. Compare rows are
 * excluded: Jev settled none of them, and counting them would read as
 * "passed to Haiku".
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
    .where(
      and(eq(usageEvents.provider, JEV_PROVIDER), gte(usageEvents.createdAt, since), isJevFirstRow)
    );

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

// ── Compare mode, for /admin ────────────────────────────────────────────────

const TIERS: readonly MessageTier[] = ['T1', 'T2', 'T3'];

function asTier(v: string | null): MessageTier | null {
  return v !== null && (TIERS as readonly string[]).includes(v) ? (v as MessageTier) : null;
}

/** One group of compare rows, as `getJevCompareStats` reads them. */
export interface JevCompareGroup {
  haikuTier: string | null;
  choice: string | null;
  wouldSettle: boolean;
  success: boolean;
  timedOut: boolean;
  n: number;
}

export interface JevCompareStats {
  days: number;
  /** Every compare row: one per message both were asked about. */
  compared: number;
  /** Rows where Jev gave an answer; the base of the agreement rate. */
  answered: number;
  errors: number;
  timeouts: number;
  /** Jev's choice === Haiku's tier. */
  agreed: number;
  /** matrix[haikuTier][jevChoice] = count, answered rows only. */
  matrix: Record<MessageTier, Record<MessageTier, number>>;
  /** Rows the Jev-first rule would have let through without Haiku. */
  wouldSettle: number;
  /**
   * THE number: of those, how many Haiku refused (T2 or T3). Each is a message
   * Jev-first would have handed to Penny that Haiku kept from her.
   */
  wouldPassHaikuRefused: number;
  wouldPassHaikuT2: number;
  wouldPassHaikuT3: number;
  /** Haiku-T1 rows, and how many of them Jev-first would have settled. */
  haikuT1: number;
  haikuT1WouldSettle: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** Pure: the grouped rows → the numbers /admin shows. */
export function summariseJevCompare(
  groups: JevCompareGroup[],
  days: number,
  latency: { p50: number | null; p95: number | null } = { p50: null, p95: null }
): JevCompareStats {
  const row = (): Record<MessageTier, number> => ({ T1: 0, T2: 0, T3: 0 });
  const matrix: Record<MessageTier, Record<MessageTier, number>> = { T1: row(), T2: row(), T3: row() };
  const s: JevCompareStats = {
    days,
    compared: 0,
    answered: 0,
    errors: 0,
    timeouts: 0,
    agreed: 0,
    matrix,
    wouldSettle: 0,
    wouldPassHaikuRefused: 0,
    wouldPassHaikuT2: 0,
    wouldPassHaikuT3: 0,
    haikuT1: 0,
    haikuT1WouldSettle: 0,
    p50Ms: latency.p50 === null ? null : Math.round(latency.p50),
    p95Ms: latency.p95 === null ? null : Math.round(latency.p95),
  };
  for (const g of groups) {
    const n = Number(g.n);
    const haiku = asTier(g.haikuTier);
    const jev = asTier(g.choice);
    s.compared += n;
    if (!g.success) s.errors += n;
    if (g.timedOut) s.timeouts += n;
    if (haiku === 'T1') s.haikuT1 += n;
    if (haiku && jev) {
      s.answered += n;
      matrix[haiku][jev] += n;
      if (haiku === jev) s.agreed += n;
    }
    if (g.wouldSettle) {
      s.wouldSettle += n;
      if (haiku === 'T1') s.haikuT1WouldSettle += n;
      if (haiku === 'T2') s.wouldPassHaikuT2 += n;
      if (haiku === 'T3') s.wouldPassHaikuT3 += n;
    }
  }
  s.wouldPassHaikuRefused = s.wouldPassHaikuT2 + s.wouldPassHaikuT3;
  return s;
}

/**
 * Compare mode's last N days: Haiku's tier against Jev's choice on the same
 * messages. Grouped in SQL, summed in `summariseJevCompare`.
 */
export async function getJevCompareStats(days = 7): Promise<JevCompareStats> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const where = and(
    eq(usageEvents.provider, JEV_PROVIDER),
    gte(usageEvents.createdAt, since),
    isCompareRow
  );
  const haikuTier = sql<string | null>`${usageEvents.meta}->>'haikuTier'`;
  const choice = sql<string | null>`${usageEvents.meta}->>'choice'`;
  const wouldSettle = sql<boolean>`COALESCE((${usageEvents.meta}->>'wouldSettle')::boolean, false)`;
  const timedOut = sql<boolean>`COALESCE(${usageEvents.meta}->>'deferredReason' = 'timeout', false)`;

  const groups = await db
    .select({
      haikuTier,
      choice,
      wouldSettle,
      success: usageEvents.success,
      timedOut,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(usageEvents)
    .where(where)
    .groupBy(haikuTier, choice, wouldSettle, usageEvents.success, timedOut);

  const [lat] = await db
    .select({
      p50: sql<number | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY (${usageEvents.meta}->>'latencyMs')::float8)`,
      p95: sql<number | null>`percentile_cont(0.95) WITHIN GROUP (ORDER BY (${usageEvents.meta}->>'latencyMs')::float8)`,
    })
    .from(usageEvents)
    .where(and(where, eq(usageEvents.success, true)));

  const num = (v: number | null | undefined) => (v === null || v === undefined ? null : Number(v));
  return summariseJevCompare(groups, days, { p50: num(lat?.p50), p95: num(lat?.p95) });
}
