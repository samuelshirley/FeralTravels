import 'server-only';
import { and, eq, gte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { db } from '@/server/db/client';
import { deferUntilSettled } from '@/server/db/turnScope';
import { appMeta, usageEvents, users } from '@/server/db/schema';
import { jevConfigStatus, type JevCompareOutcome, type JevTierOutcome } from '@/server/jev';

export { MIN_MARGIN as JEV_MIN_MARGIN } from '@/server/jev';
import { CLASSIFY_MODEL } from '@/lib/models';
import { CLASSIFY_MAX_TOKENS } from '@/lib/pennyClassifierPrompt';
import type { MessageTier } from '@/lib/pennyGate';
import { compareRowTruth, isJevRoute, JEV_ROUTES, type JevRoute } from '@/lib/jevRoute';
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
 * `usage_events.meta` for a compare-mode row: Jev's answers beside what the
 * gate decided. Same key-by-key rule as `jevUsageMeta`, and never user text.
 *
 * Two kinds of message are compared:
 *
 *  - `gateBy: 'classifier'` — the free rules could not decide, so Haiku was
 *    asked, and Jev was asked the same TIER question and the ROUTE question
 *    in one request. `haikuTier` is Haiku's answer.
 *  - `gateBy: 'allow_rule'` — the free rules already let it through (a trip
 *    name, a Maps link, "fuel"…). No classifier was asked, so Jev is asked the
 *    ROUTE question only: these are exactly the messages cases 2 and 3 are
 *    about, and leaving them out would measure nothing. `tierAsked` is false
 *    and every tier key is null/false; the tier stats leave these rows out.
 *
 * Tier: `settled` is always false — in compare mode Jev settles nothing.
 * `wouldSettle` is whether the Jev-first rule (`settlesAsT1`) would have let
 * this message through without Haiku. `agree` is Jev's CHOICE against Haiku's
 * TIER, false when Jev gave no answer. `tierConfident` = Jev's tier answer
 * cleared Jev-first's bar whatever the tier (case 1: a confident T2/T3).
 * `haikuMicrocents` = what Haiku's classifier call for THIS message cost, as
 * `classifyMessage` measured it — the gate-only saving if Jev had decided.
 *
 * Route: `route`, `routeTop`, `routeMargin`, `routeConfident`. `truth` is the
 * route the evidence says the message needed (`src/lib/jevRoute.ts`): set to
 * `off_topic` here when Haiku refused it, else filled in by
 * `recordJevTurnTruth` once Penny's turn ends.
 */
export interface JevCompareMeta {
  mode: 'compare';
  source: JevModeSource;
  gateBy: 'classifier' | 'allow_rule';
  tierAsked: boolean;
  choice: MessageTier | null;
  top: number | null;
  margin: number | null;
  latencyMs: number | null;
  settled: false;
  wouldSettle: boolean;
  haikuTier: MessageTier | null;
  agree: boolean;
  tierConfident: boolean;
  haikuMicrocents: number | null;
  route: JevRoute | null;
  routeTop: number | null;
  routeMargin: number | null;
  routeConfident: boolean;
  truth: JevRoute | null;
  deferredReason: string | null;
  echoedModel: string | null;
}

const round4 = (n: number | null) => (n === null ? null : Math.round(n * 10_000) / 10_000);

export function jevCompareMeta(
  source: JevModeSource,
  o: JevCompareOutcome,
  gate: { by: 'classifier' | 'allow_rule'; haikuTier: MessageTier | null; haikuMicrocents: number | null }
): JevCompareMeta {
  const tierAsked = gate.by === 'classifier';
  const t = tierAsked ? o.tier : null;
  const haikuTier = tierAsked ? gate.haikuTier : null;
  const choice = t?.choice ?? null;
  return {
    mode: 'compare',
    source,
    gateBy: gate.by,
    tierAsked,
    choice,
    top: round4(t?.top ?? null),
    margin: round4(t?.margin ?? null),
    latencyMs: o.call.latencyMs === null ? null : Math.round(o.call.latencyMs),
    settled: false,
    wouldSettle: t?.settled ?? false,
    haikuTier,
    agree: choice !== null && choice === haikuTier,
    tierConfident: tierAsked && o.tierConfident,
    haikuMicrocents:
      tierAsked && gate.haikuMicrocents !== null && Number.isFinite(gate.haikuMicrocents)
        ? Math.round(gate.haikuMicrocents)
        : null,
    route: isJevRoute(o.route.choice) ? o.route.choice : null,
    routeTop: round4(o.route.top),
    routeMargin: round4(o.route.margin),
    routeConfident: o.route.confident,
    truth: compareRowTruth({ tierAsked, haikuTier, turnTruth: null }),
    deferredReason: o.call.deferredReason,
    // The backend's own string, capped. Logged, never compared.
    echoedModel: o.call.echoedModel === null ? null : o.call.echoedModel.slice(0, 80),
  };
}

/**
 * One row per Jev-first call: `provider: 'jev'`, cost 0, tokens,
 * success/error, `meta`. Never throws — a bookkeeping failure must not refuse
 * a message.
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
    // Accounting: deferred past an open Penny turn transaction (server/db/turnScope.ts).
    await deferUntilSettled(() =>
      db.insert(usageEvents).values({
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
      }),
    );
  } catch (err) {
    console.error('[repos/jev] could not record the Jev call', err);
  }
}

/**
 * One row per compare-mode Jev call — `input_tokens` is the request's input
 * token count as TypeSafe reported it, so the cost of the route question
 * shows per call. Returns the row's id, which the replan route hands back to
 * `linkJevCompareToTurn` so the turn's ground truth lands on this row; null
 * when the insert failed. Never throws.
 */
export async function logJevCompare(input: {
  userId: string;
  tripId: string | null;
  source: JevModeSource;
  outcome: JevCompareOutcome;
  gate: { by: 'classifier' | 'allow_rule'; haikuTier: MessageTier | null; haikuMicrocents: number | null };
}): Promise<number | null> {
  const o = input.outcome;
  try {
    const rows = await deferUntilSettled(() =>
      db
        .insert(usageEvents)
        .values({
          userId: input.userId,
          tripId: input.tripId,
          provider: JEV_PROVIDER,
          model: o.call.echoedModel,
          inputTokens: o.call.inputTokens,
          outputTokens: o.call.outputTokens,
          requests: 1,
          costMicrocents: 0,
          success: o.call.success,
          errorMessage: o.call.errorMessage === null ? null : o.call.errorMessage.slice(0, 200),
          meta: jevCompareMeta(input.source, o, input.gate),
        })
        .returning({ id: usageEvents.id }),
    );
    const row = rows?.[0];
    return row?.id ?? null;
  } catch (err) {
    console.error('[repos/jev] could not record the Jev compare call', err);
    return null;
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
/**
 * Compare rows where Jev was asked the TIER question beside Haiku. Rows from
 * before the route question have no `tierAsked` key, and every one of them
 * was a tier comparison.
 */
const tierWasAsked = sql`COALESCE(${usageEvents.meta}->>'tierAsked', 'true') = 'true'`;
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
 * messages — classifier-path rows only (`tierAsked`); the route-only rows of
 * messages the free rules let through have no Haiku tier to compare.
 * Grouped in SQL, summed in `summariseJevCompare`.
 */
export async function getJevCompareStats(days = 7): Promise<JevCompareStats> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const where = and(
    eq(usageEvents.provider, JEV_PROVIDER),
    gte(usageEvents.createdAt, since),
    isCompareRow,
    tierWasAsked
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

// ── Route measurement: ground truth, and /admin ─────────────────────────────

/**
 * Tag a compare row with the Penny turn its message started. Called by the
 * replan route right after the turn row exists; `recordJevTurnTruth` finds
 * the row again by this id when the turn ends — including a turn that was
 * queued and drained later, which never sees the gate's return value.
 * Never throws: the measurement must not cost the driver their turn.
 */
export async function linkJevCompareToTurn(eventId: number, turnId: string): Promise<void> {
  try {
    await deferUntilSettled(() =>
      db
        .update(usageEvents)
        .set({ meta: sql`COALESCE(${usageEvents.meta}, '{}'::jsonb) || ${JSON.stringify({ pennyTurnId: turnId })}::jsonb` })
        .where(and(eq(usageEvents.id, eventId), eq(usageEvents.provider, JEV_PROVIDER), isCompareRow)),
    );
  } catch (err) {
    console.error('[repos/jev] could not link the compare row to its turn', err);
  }
}

/** The compare row a turn's message wrote, if compare mode asked Jev about it. */
export async function findJevCompareForTurn(tripId: string, turnId: string): Promise<number | null> {
  const [row] = await db
    .select({ id: usageEvents.id })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.provider, JEV_PROVIDER),
        eq(usageEvents.tripId, tripId),
        isCompareRow,
        sql`${usageEvents.meta}->>'pennyTurnId' = ${turnId}`
      )
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * What Penny's turn actually did, merged onto the compare row — names,
 * counts, booleans and day numbers, built key by key, never a word the driver
 * wrote. `truth` is `turnRouteTruth(facts)` (`src/lib/jevRoute.ts`, where the
 * definition of "Jev's route was right" lives). `pennyUsageEventId` points at
 * the `provider: 'anthropic'` row holding the turn's measured cost.
 */
export interface JevTurnTruthMeta {
  turnStatus: 'done' | 'error';
  truth: JevRoute | null;
  toolCounts: Record<string, number>;
  appliedCounts: Record<string, number>;
  failedCount: number;
  fuelPlanRan: boolean;
  fuelStopUpdates: number;
  fuelStopDeletes: number;
  otherStopEdits: number;
  mapsLinkCount: number;
  /** `parseDayReference`'s kind on the message, when the turn added a stop. */
  dayParseKind: string | null;
  parsedDay: number | null;
  /** The day number of each leg Penny's persisted `add_stop`s landed on. */
  addedDays: number[];
  /** parsedDay is one of addedDays; null when either side is missing. */
  dayMatch: boolean | null;
  pennyUsageEventId: number | null;
}

/** Tool names are the registry's own; anything else is counted, never named. */
function cleanCounts(counts: Record<string, number>, known: ReadonlySet<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, n] of Object.entries(counts)) {
    if (!Number.isFinite(n) || n <= 0) continue;
    const key = known.has(name) ? name : 'unknown_tool';
    out[key] = (out[key] ?? 0) + Math.round(n);
  }
  return out;
}

export function jevTurnTruthMeta(
  t: JevTurnTruthMeta,
  knownTools: ReadonlySet<string>
): JevTurnTruthMeta {
  const int = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
  return {
    turnStatus: t.turnStatus === 'done' ? 'done' : 'error',
    truth: isJevRoute(t.truth) ? t.truth : null,
    toolCounts: cleanCounts(t.toolCounts, knownTools),
    appliedCounts: cleanCounts(t.appliedCounts, knownTools),
    failedCount: int(t.failedCount),
    fuelPlanRan: t.fuelPlanRan === true,
    fuelStopUpdates: int(t.fuelStopUpdates),
    fuelStopDeletes: int(t.fuelStopDeletes),
    otherStopEdits: int(t.otherStopEdits),
    mapsLinkCount: int(t.mapsLinkCount),
    dayParseKind:
      t.dayParseKind !== null && /^[a-z_]{1,20}$/.test(t.dayParseKind) ? t.dayParseKind : null,
    parsedDay: t.parsedDay === null || !Number.isFinite(t.parsedDay) ? null : Math.round(t.parsedDay),
    addedDays: t.addedDays.filter((d) => Number.isFinite(d)).map((d) => Math.round(d)).slice(0, 10),
    dayMatch: typeof t.dayMatch === 'boolean' ? t.dayMatch : null,
    pennyUsageEventId:
      t.pennyUsageEventId === null || !Number.isFinite(t.pennyUsageEventId) ? null : Math.round(t.pennyUsageEventId),
  };
}

/** Merge the turn's truth onto its compare row. Never throws. */
export async function recordJevTurnTruth(
  eventId: number,
  truth: JevTurnTruthMeta,
  knownTools: ReadonlySet<string>
): Promise<void> {
  try {
    const meta = jevTurnTruthMeta(truth, knownTools);
    await deferUntilSettled(() =>
      db
        .update(usageEvents)
        .set({ meta: sql`COALESCE(${usageEvents.meta}, '{}'::jsonb) || ${JSON.stringify(meta)}::jsonb` })
        .where(and(eq(usageEvents.id, eventId), eq(usageEvents.provider, JEV_PROVIDER), isCompareRow)),
    );
  } catch (err) {
    console.error('[repos/jev] could not record the turn truth on the compare row', err);
  }
}

/** One group of compare rows as `getJevRouteStats` reads them. */
export interface JevRouteGroup {
  route: string | null;
  routeConfident: boolean;
  truth: string | null;
  turnStatus: string | null;
  tierAsked: boolean;
  haikuTier: string | null;
  choice: string | null;
  tierConfident: boolean;
  dayParseKind: string | null;
  dayMatch: boolean | null;
  n: number;
  /** Rows in the group whose Penny turn has a cost row. */
  pennyCostRows: number;
  /** Σ the measured cost of those turns, microcents. */
  pennyMicrocents: number;
  /** Σ the measured cost of Haiku's classifier call for these messages, microcents. */
  haikuMicrocents: number;
  inputTokens: number;
}

export interface JevRouteIntentStats {
  route: JevRoute;
  /** Rows whose truth is known that Jev confidently sent here. */
  routedConfident: number;
  /** ...of which the truth agreed. */
  correctConfident: number;
  /** Rows whose truth is this route. */
  truthCount: number;
  /** Correct confident routes whose cost was measured. */
  costedRows: number;
  /**
   * Dollars a code path would have saved: for the two Penny routes, the sum
   * of the MEASURED Anthropic cost of each correctly, confidently routed
   * turn; for `off_topic`, the measured classifier calls those messages cost.
   * 0 for `needs_penny`, which goes to Penny either way.
   */
  avoidedUsd: number;
}

export interface JevRouteStats {
  days: number;
  /** Compare rows in the window. */
  compared: number;
  /** ...with a readable route answer. */
  answered: number;
  /** ...and a known truth: the base of every precision and coverage number. */
  graded: number;
  /** Answered T1 messages whose turn has not recorded a truth (yet, or ever). */
  ungraded: number;
  /** Turns that errored: left out, never guessed. */
  erroredTurns: number;
  intents: JevRouteIntentStats[];
  /**
   * Case 1 on the TIER question: Jev confidently said T2/T3 (cleared
   * Jev-first's bar). `agreed` = Haiku said the same tier; the rest split by
   * what Haiku said. `avoidedUsd` = the measured cost of Haiku's call on the
   * agreed messages — the most a Jev-decided refusal could save, because an
   * off-topic message never reaches Penny anyway.
   */
  gateOnly: {
    confidentRefusals: number;
    agreed: number;
    haikuSaidT1: number;
    otherRefusalTier: number;
    avoidedUsd: number;
  };
  /** Case 2: the free day parse against the day Penny put the stop on. */
  day: { graded: number; matched: number; byKind: Record<string, number> };
  /** Input tokens TypeSafe reported, per call. */
  avgInputTokens: number | null;
}

const ALL_ROUTES = JEV_ROUTES;

/** Pure: the grouped rows → the numbers /admin shows. */
export function summariseJevRoutes(groups: JevRouteGroup[], days: number): JevRouteStats {
  const intents = new Map<JevRoute, JevRouteIntentStats>(
    ALL_ROUTES.map((route) => [
      route,
      { route, routedConfident: 0, correctConfident: 0, truthCount: 0, costedRows: 0, avoidedUsd: 0 },
    ])
  );
  const s: JevRouteStats = {
    days,
    compared: 0,
    answered: 0,
    graded: 0,
    ungraded: 0,
    erroredTurns: 0,
    intents: [],
    gateOnly: { confidentRefusals: 0, agreed: 0, haikuSaidT1: 0, otherRefusalTier: 0, avoidedUsd: 0 },
    day: { graded: 0, matched: 0, byKind: {} },
    avgInputTokens: null,
  };
  let tokens = 0;
  for (const g of groups) {
    const n = Number(g.n);
    s.compared += n;
    tokens += Number(g.inputTokens);
    if (g.turnStatus === 'error') s.erroredTurns += n;

    // Case 1, tier question.
    if (g.tierAsked && g.tierConfident && (g.choice === 'T2' || g.choice === 'T3')) {
      s.gateOnly.confidentRefusals += n;
      if (g.haikuTier === g.choice) {
        s.gateOnly.agreed += n;
        s.gateOnly.avoidedUsd += microcentsToDollars(Number(g.haikuMicrocents));
      } else if (g.haikuTier === 'T1') s.gateOnly.haikuSaidT1 += n;
      else s.gateOnly.otherRefusalTier += n;
    }

    const route = isJevRoute(g.route) ? g.route : null;
    if (route === null) continue;
    s.answered += n;
    const truth = isJevRoute(g.truth) ? g.truth : null;
    if (truth === null) {
      if (g.turnStatus !== 'error') s.ungraded += n;
      continue;
    }
    s.graded += n;
    intents.get(truth)!.truthCount += n;
    if (g.routeConfident) {
      const it = intents.get(route)!;
      it.routedConfident += n;
      if (route === truth) {
        it.correctConfident += n;
        if (route === 'add_pasted_place' || route === 'replace_fuel_stop') {
          it.costedRows += Number(g.pennyCostRows);
          it.avoidedUsd += microcentsToDollars(Number(g.pennyMicrocents));
        } else if (route === 'off_topic') {
          it.costedRows += n;
          it.avoidedUsd += microcentsToDollars(Number(g.haikuMicrocents));
        }
      }
    }
    if (truth === 'add_pasted_place' && g.dayParseKind !== null) {
      s.day.byKind[g.dayParseKind] = (s.day.byKind[g.dayParseKind] ?? 0) + n;
      if (g.dayMatch !== null) {
        s.day.graded += n;
        if (g.dayMatch) s.day.matched += n;
      }
    }
  }
  s.intents = ALL_ROUTES.map((r) => intents.get(r)!);
  s.avgInputTokens = s.compared > 0 ? Math.round(tokens / s.compared) : null;
  return s;
}

/**
 * Compare mode's route measurement, last N days. Grouped in SQL; each Penny
 * turn's cost is read from ITS OWN `provider: 'anthropic'` row (joined on
 * `meta.pennyUsageEventId`), so "dollars avoided" is a sum of what those
 * turns actually cost, never an average times a count.
 */
export async function getJevRouteStats(days = 7): Promise<JevRouteStats> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const penny = alias(usageEvents, 'penny_cost');
  const m = usageEvents.meta;
  const route = sql<string | null>`${m}->>'route'`;
  const routeConfident = sql<boolean>`COALESCE((${m}->>'routeConfident')::boolean, false)`;
  const truth = sql<string | null>`${m}->>'truth'`;
  const turnStatus = sql<string | null>`${m}->>'turnStatus'`;
  const tierAsked = sql<boolean>`COALESCE((${m}->>'tierAsked')::boolean, true)`;
  const haikuTier = sql<string | null>`${m}->>'haikuTier'`;
  const choice = sql<string | null>`${m}->>'choice'`;
  const tierConfident = sql<boolean>`COALESCE((${m}->>'tierConfident')::boolean, false)`;
  const dayParseKind = sql<string | null>`${m}->>'dayParseKind'`;
  const dayMatch = sql<boolean | null>`(${m}->>'dayMatch')::boolean`;

  const groups = await db
    .select({
      route,
      routeConfident,
      truth,
      turnStatus,
      tierAsked,
      haikuTier,
      choice,
      tierConfident,
      dayParseKind,
      dayMatch,
      n: sql<number>`COUNT(*)::int`,
      pennyCostRows: sql<number>`COUNT(${penny.id})::int`,
      pennyMicrocents: sql<number>`COALESCE(SUM(${penny.costMicrocents}), 0)::float8`,
      haikuMicrocents: sql<number>`COALESCE(SUM((${m}->>'haikuMicrocents')::float8), 0)::float8`,
      inputTokens: sql<number>`COALESCE(SUM(${usageEvents.inputTokens}), 0)::float8`,
    })
    .from(usageEvents)
    .leftJoin(
      penny,
      and(
        sql`${penny.id} = (${m}->>'pennyUsageEventId')::bigint`,
        eq(penny.provider, 'anthropic')
      )
    )
    .where(and(eq(usageEvents.provider, JEV_PROVIDER), gte(usageEvents.createdAt, since), isCompareRow))
    .groupBy(route, routeConfident, truth, turnStatus, tierAsked, haikuTier, choice, tierConfident, dayParseKind, dayMatch);

  return summariseJevRoutes(groups, days);
}
