import 'server-only';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { Resend } from 'resend';
import { db } from '@/server/db/client';
import { breakerAlerts, usageEvents, users } from '@/server/db/schema';
import { adminAlertRecipients, isOnAdminAllowlist } from '@/server/auth/admin';
import { areTestEndpointsEnabled, isFixtureRecipient } from '@/server/auth/test-endpoints';
import { CircuitOpenError } from '@/server/auth/errors';
import { BREAKERS, BREAKER_CACHE_MS, MICROCENTS_PER_DOLLAR } from './constants';
import {
  evaluateBreakers,
  evaluateGate,
  worstLevel,
  type BreakerFacts,
  type BreakerGate,
  type BreakerLevel,
  type BreakerStatus,
  type GateVerdict,
} from './breakers';
import { pennyLocked } from './switch';
import { assertIpAllowed } from '@/server/ipLimit';

/**
 * The database side of the circuit breakers: read the facts, cache them, ask
 * the pure evaluator, and mail the owner when a line is crossed.
 *
 * The decision itself is in `breakers.ts` and takes its numbers as arguments.
 * This file exists to supply those numbers cheaply and to be wrong in a safe
 * direction when it cannot.
 */

/** The provider prefix a gate decision is logged under. Counted by `gated_messages_1h`. */
export const GATE_PROVIDER = 'penny:gate';

/**
 * The tier stored in `usage_events.model` for a message the gate REFUSED.
 * Only T3 counts toward the junk breaker — T2 is a real driver asking a real
 * question we cannot answer, and counting those as junk would make the smoke
 * detector go off at the smell of cooking.
 */
const JUNK_TIER = 'T3';

/**
 * How long a reading may be reused — zero on a deployment with the E2E fixture
 * endpoints switched on.
 *
 * NOT a widening. Every other test-only branch in this codebase is written as
 * "a guard you can turn off with an env var is not a guard"; this one turns off
 * a STALENESS ALLOWANCE, so the gated path becomes stricter rather than looser,
 * and the worst it can cost is one extra aggregate query per request on a
 * throwaway preview.
 *
 * It exists because the alternative is a flaky spec. `e2e/breakers.spec.ts`
 * seeds spend and then asks the replan route to refuse it, and with the cache
 * live the request may land on an instance that read "all clear" twenty seconds
 * earlier — so the spec would fail for a reason that is not a bug, and the only
 * ways to make it pass would be to sleep for the cache window on every run or
 * to retry by making REAL Penny calls at $0.085 each.
 *
 * `areTestEndpointsEnabled()` is hard-off when `VERCEL_ENV === 'production'`
 * with no override env var, unit-enforced in `test-endpoints.test.ts`, so
 * production always takes the cache.
 */
function cacheMs(): number {
  return areTestEndpointsEnabled() ? 0 : BREAKER_CACHE_MS;
}

let cached: { facts: BreakerFacts; at: number } | null = null;

/** Drop the cached reading — used by the tests and by the lock writer. */
export function invalidateBreakerFacts(): void {
  cached = null;
}

async function sumAnthropicMicrocents(sinceMs: number): Promise<number> {
  const rows = await db
    .select({ microcents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)` })
    .from(usageEvents)
    .where(
      and(
        gte(usageEvents.createdAt, new Date(sinceMs)),
        // `LIKE 'anthropic%'`, not `= 'anthropic'`, for the same reason
        // `anthropicMicrocentsInWindow` gives: the namespaced rows
        // (`anthropic:accounting-write-failed`) are real money, and they exist
        // precisely because the primary insert threw.
        sql`${usageEvents.provider} LIKE 'anthropic%'`
      )
    );
  return Number(rows[0]?.microcents ?? 0);
}

async function countSignups(sinceMs: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(users)
    .where(gte(users.createdAt, new Date(sinceMs)));
  return Number(rows[0]?.n ?? 0);
}

async function countJunkMessages(sinceMs: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)::int` })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.provider, GATE_PROVIDER),
        eq(usageEvents.model, JUNK_TIER),
        gte(usageEvents.createdAt, new Date(sinceMs))
      )
    );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Every fact the breakers need, in one round of queries.
 *
 * `Promise.all` rather than sequential: this sits in front of every Penny turn
 * and every OTP send, so its latency is the app's latency. Five small indexed
 * aggregates in parallel is ~one query's worth of wall clock.
 *
 * On ANY failure it returns `factsUnavailable: true` rather than throwing or
 * substituting zeros. Zeros would be the worst possible answer — they read as
 * "the app has spent nothing", which is precisely the state a breaker is meant
 * to distinguish from.
 */
export async function readBreakerFacts(now = Date.now()): Promise<BreakerFacts> {
  const hourAgo = now - 60 * 60 * 1000;
  const dayAgo = now - 24 * 60 * 60 * 1000;
  try {
    const [spend24, spend1, signups1, signups24, junk1, locked] = await Promise.all([
      sumAnthropicMicrocents(dayAgo),
      sumAnthropicMicrocents(hourAgo),
      countSignups(hourAgo),
      countSignups(dayAgo),
      countJunkMessages(hourAgo),
      pennyLocked(now),
    ]);
    return {
      anthropicMicrocents24h: spend24,
      anthropicMicrocents1h: spend1,
      signups1h: signups1,
      signups24h: signups24,
      gatedMessages1h: junk1,
      manualLock: locked,
      factsUnavailable: false,
    };
  } catch (err) {
    console.error('[payments/breakerCheck] could not read the breaker facts', err);
    return {
      anthropicMicrocents24h: 0,
      anthropicMicrocents1h: 0,
      signups1h: 0,
      signups24h: 0,
      gatedMessages1h: 0,
      manualLock: true,
      factsUnavailable: true,
    };
  }
}

/**
 * The cached reading.
 *
 * A failed read is NOT cached — the same rule the paywall switch follows, and
 * it matters more here: pinning `factsUnavailable` for thirty seconds would
 * turn one bad query into thirty seconds of refusals for everybody.
 */
export async function breakerFacts(now = Date.now()): Promise<BreakerFacts> {
  if (cached && now - cached.at < cacheMs()) return cached.facts;
  const facts = await readBreakerFacts(now);
  if (!facts.factsUnavailable) cached = { facts, at: now };
  return facts;
}

export interface BreakerSnapshot {
  facts: BreakerFacts;
  statuses: BreakerStatus[];
  worst: BreakerLevel;
}

/**
 * Everything the admin panel renders. Uncached by default: the panel is read by
 * one person at a time, and showing them a value from before they threw the
 * switch is the failure this whole design was moved out of the environment to
 * avoid.
 */
export async function breakerSnapshot(opts: { fresh?: boolean } = {}): Promise<BreakerSnapshot> {
  const facts = opts.fresh === false ? await breakerFacts() : await readBreakerFacts();
  const statuses = evaluateBreakers(facts, BREAKERS);
  return { facts, statuses, worst: worstLevel(statuses) };
}

/**
 * THE GATE. Called before any model call and before any OTP is sent.
 *
 * Fires the alert emails as a side effect — deliberately here rather than
 * inside the pure evaluator, exactly as `requireEntitledUser` fires the per-user
 * threshold email outside `resolveAccountState`, and never awaited: an alert
 * that fails must not turn into a failed request for whoever happened to be the
 * one to cross the line.
 */
export async function checkBreakerGate(gate: BreakerGate): Promise<GateVerdict> {
  const facts = await breakerFacts();
  const statuses = evaluateBreakers(facts, BREAKERS);
  void maybeAlertBreakers(statuses).catch((err) =>
    console.error('[payments/breakerCheck] alerting failed', err)
  );
  return evaluateGate(gate, facts, BREAKERS);
}

/**
 * How long before the same (breaker, level) may mail again.
 *
 * The breaker's own window, floored at an hour. A daily breaker that stays open
 * all day is one email; an hourly one that keeps re-opening is one an hour,
 * which is the rate at which it is telling you something new.
 */
export function alertCooldownMs(windowHours: number): number {
  return Math.max(1, windowHours) * 60 * 60 * 1000;
}

/**
 * Claim the right to send. Atomic, in the same shape as `maybeAlertThreshold`'s
 * insert-then-check: the upsert only takes effect when the stored `fired_at` is
 * older than the cooldown, so two instances crossing the line in the same second
 * produce one email.
 */
async function claimAlert(
  breaker: string,
  level: 'alert' | 'open',
  value: number,
  cooldownMs: number,
  now: Date
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - cooldownMs);
  const claimed = await db
    .insert(breakerAlerts)
    .values({ breaker, level, valueAtFiring: Math.round(value), firedAt: now })
    .onConflictDoUpdate({
      target: [breakerAlerts.breaker, breakerAlerts.level],
      set: { firedAt: now, valueAtFiring: Math.round(value) },
      setWhere: lt(breakerAlerts.firedAt, cutoff),
    })
    .returning({ breaker: breakerAlerts.breaker });
  return claimed.length > 0;
}

/** Never throws. See `maybeAlertThreshold` — the reasoning is identical. */
export async function maybeAlertBreakers(statuses: readonly BreakerStatus[]): Promise<void> {
  const now = new Date();
  for (const status of statuses) {
    if (status.level === 'ok') continue;
    try {
      const claimed = await claimAlert(
        status.id,
        status.level,
        status.value,
        alertCooldownMs(status.windowHours),
        now
      );
      if (!claimed) continue;
      await sendBreakerEmail(status).catch((err) =>
        console.error('[payments/breakerCheck] send failed', err)
      );
    } catch (err) {
      console.error('[payments/breakerCheck] alert bookkeeping failed', err);
    }
  }
}

/** Format a breaker's value the way its unit demands. */
export function formatBreakerValue(status: Pick<BreakerStatus, 'unit' | 'value'>): string {
  return status.unit === 'microcents'
    ? `$${(status.value / MICROCENTS_PER_DOLLAR).toFixed(2)}`
    : String(status.value);
}

function formatLimit(status: BreakerStatus, limit: number | null): string {
  if (limit === null) return 'none';
  return formatBreakerValue({ unit: status.unit, value: limit });
}

async function sendBreakerEmail(status: BreakerStatus): Promise<void> {
  const apiKey = process.env.AUTH_RESEND_KEY;
  const from = process.env.AUTH_EMAIL_FROM;
  if (!apiKey || !from) {
    console.error('[payments/breakerCheck] Resend not configured; breaker alert not sent', {
      breaker: status.id,
      level: status.level,
    });
    return;
  }

  const value = formatBreakerValue(status);
  const alertAt = formatLimit(status, status.alertAt);
  const stopAt = formatLimit(status, status.stopAt);

  // The subject carries the number AND both lines, because the only thing the
  // owner can do from a phone notification is decide whether to open the laptop,
  // and "spend is high" does not answer that. "$10.40 in 24h (alert at $10, stop
  // at $25)" does.
  const subject = `[${status.level.toUpperCase()}] ${status.label}: ${value} (alert at ${alertAt}, stop at ${stopAt})`;

  const lines = [
    status.level === 'open'
      ? 'CIRCUIT OPEN — non-admin requests through this gate are being refused with a 503.'
      : 'Alert line crossed. Nothing is being refused; this is a warning.',
    '',
    `Breaker:   ${status.id} (${status.label})`,
    `Now:       ${value}`,
    `Alert at:  ${alertAt}`,
    `Stop at:   ${stopAt}`,
    '',
    status.gate === 'signup'
      ? 'Sign-ups are affected. Existing accounts can still sign in — only NEW addresses are refused.'
      : 'Penny is affected. Sign-in, the itinerary and account deletion are not.',
    '',
    'The switch that closes Penny entirely by hand is on /admin ("Penny lockdown").',
    'To see WHAT is spending: scripts/anthropic-usage-report.ts, and toolTrace on',
    'the recent rows in penny_turns.',
  ];

  const resend = new Resend(apiKey);
  const result = await resend.emails.send({
    from,
    to: adminAlertRecipients(),
    subject,
    text: lines.join('\n'),
  });
  if (result.error) console.error('[payments/breakerCheck] Resend error', result.error);
}

/**
 * Refuse a Penny request if the spend gate is open. Admins are exempt from the
 * STOP and never from the accounting — the same split the per-user caps make,
 * so the operator can find out what is happening while it is happening.
 */
export async function assertPennyGateOpen(isAdmin: boolean): Promise<void> {
  const verdict = await checkBreakerGate('penny');
  if (!verdict.blocked || isAdmin) return;
  throw new CircuitOpenError(verdict.breaker ?? 'unknown', verdict.retryAfterSeconds);
}

/**
 * May this address create an account here, right now?
 *
 * TWO gates, one address lookup, and the lookup is why they are in one
 * function rather than two calls at every route: both only apply to an address
 * with no account yet, and asking the database twice on the sign-in path to
 * answer the same question would be a query per sign-in for nothing.
 *
 *  1. The global sign-up circuit breaker (50/100 an hour, 100/200 a day).
 *  2. The per-IP account-creation limit (5 a day).
 *
 * ── Why it is scoped to NEW addresses, which is the whole design ──
 *
 * A flood is a thousand addresses nobody has ever seen. The people it must not
 * lock out are the ones already using the app, who are exactly the ones with a
 * `users` row — and a household, an office or a university shares one public
 * address, so a per-IP limit applied to every sign-in would refuse honest
 * people on the second cup of coffee. Refusing every sign-in during a flood
 * takes the app down on the attacker's behalf, which is the outcome this whole
 * file exists to prevent.
 *
 * ── It lives here rather than in `ipLimit.ts` ──
 *
 * Because the expensive half is the breaker and the breaker is a payments
 * decision. `ipLimit.ts` stays a general mechanism with no idea what a sign-up
 * is; this is the one place that composes it with the money question.
 *
 * A failed lookup treats the address as NEW and applies both gates. That is the
 * fail-closed direction, and it is reached only when the database is already
 * failing — at which point sign-in was not going to work anyway.
 */
export async function assertSignupGateOpen(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (isOnAdminAllowlist(normalized)) return;

  let known = false;
  try {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${normalized}`)
      .limit(1);
    known = rows.length > 0;
  } catch (err) {
    console.error('[payments/breakerCheck] could not check for an existing account', err);
  }
  if (known) return;

  const verdict = await checkBreakerGate('signup');
  if (verdict.blocked) {
    throw new CircuitOpenError(
      verdict.breaker ?? 'unknown',
      verdict.retryAfterSeconds,
      'New sign-ups are paused for a moment. Existing accounts can still sign in.'
    );
  }

  /*
   * Fixture addresses are exempt, and this is BELT AND BRACES rather than
   * duplication.
   *
   * The Playwright suite creates a fresh account per spec — twelve-plus of them
   * — from ONE runner address, against a limit of five a day. That is exactly
   * the shape this refuses, and the suite is meant to be covered by the
   * `x-e2e-test-secret` exemption inside `checkIpLimit`. But that exemption
   * depends on the header reaching a Next SERVER ACTION (the web login form is
   * one), and "the header propagates" is a property of Playwright's request
   * plumbing rather than of this code — so it is the wrong single point of
   * failure for "can CI sign anybody in".
   *
   * `isFixtureRecipient` is the second, independent belt: a hardcoded address
   * shape on a subdomain with no MX, ANDed with `areTestEndpointsEnabled()`,
   * which is hard-off on production with no override. Both halves are already
   * unit-enforced in `test-endpoints.test.ts`.
   *
   * Deliberately NOT covering `e2e/login-otp.spec.ts`, which signs in on a real
   * receiving domain so a real email is sent: it creates ONE account per run,
   * comfortably inside the limit, and exempting it would mean widening the
   * pattern to a domain that can receive mail.
   */
  if (isFixtureRecipient(normalized)) return;

  await assertIpAllowed('signup');
}

export interface GateMix {
  tier: string;
  decisions: number;
}

/**
 * Gate decisions in the last N hours, by tier — the mix the deterministic
 * layers were supposed to shift.
 *
 * Reads the same rows `gated_messages_1h` counts. Nothing is recorded for the
 * admin panel that the breaker does not already need.
 */
export async function gateMixSince(hours = 24): Promise<GateMix[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await db
    .select({
      tier: usageEvents.model,
      decisions: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)::int`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.provider, GATE_PROVIDER), gte(usageEvents.createdAt, since)))
    .groupBy(usageEvents.model);
  return rows
    .map((r) => ({ tier: r.tier ?? 'unknown', decisions: Number(r.decisions) }))
    .sort((a, b) => a.tier.localeCompare(b.tier));
}

/** The accounts sending the most REFUSED messages. Five, because it is a lead, not a report. */
export async function topGatedAccounts(
  hours = 24,
  limit = 5
): Promise<Array<{ email: string | null; refused: number }>> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await db
    .select({
      email: users.email,
      refused: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)::int`,
    })
    .from(usageEvents)
    .innerJoin(users, eq(usageEvents.userId, users.id))
    .where(
      and(
        eq(usageEvents.provider, GATE_PROVIDER),
        gte(usageEvents.createdAt, since),
        sql`${usageEvents.model} IN ('T2', 'T3')`
      )
    )
    .groupBy(users.email)
    .orderBy(sql`SUM(${usageEvents.requests}) DESC`)
    .limit(limit);
  return rows.map((r) => ({ email: r.email, refused: Number(r.refused) }));
}
