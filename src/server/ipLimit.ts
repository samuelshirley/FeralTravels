import 'server-only';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { headers } from 'next/headers';
import { db } from '@/server/db/client';
import { ipRequestCounters } from '@/server/db/schema';
import { isTestRequestAuthorizedByHeaders } from '@/server/auth/test-endpoints';
import { TooManyRequestsError } from '@/server/auth/errors';
import {
  clientIpFromHeaders,
  decideIpLimit,
  limitFor,
  windowStartMs,
  type IpLimitVerdict,
  type IpScope,
} from '@/lib/ipLimit';

/**
 * The database side of the per-IP limits: count this request, decide, refuse.
 *
 * The decision is in `src/lib/ipLimit.ts` and takes its numbers as arguments.
 * This file gets the address, does the one write that makes the count true, and
 * knows who is exempt.
 */

/** How long a counter row survives after its last write. */
export const IP_COUNTER_RETENTION_DAYS = 7;

/**
 * Roughly one prune per this many checks.
 *
 * There is no cron in this app — it was cut from the MVP on purpose — so the
 * cleanup rides on the traffic that creates the rows. That is the right shape
 * for this table: it only grows when requests arrive, so it only needs pruning
 * when requests arrive, and a quiet app does no work at all. One in five
 * hundred at the limits above is a prune every few hours under real traffic and
 * every few seconds under the flood, which is exactly backwards from a cron and
 * exactly right here.
 */
const PRUNE_ONE_IN = 500;

/** Read a header, or null when there is no request scope at all. */
async function headerReader(): Promise<(name: string) => string | null> {
  try {
    const h = await headers();
    return (name: string) => h.get(name);
  } catch {
    // `headers()` throws outside a request (a script, a test). No address, no
    // counting — see `clientIpFromHeaders` on why null must not be a bucket.
    return () => null;
  }
}

/**
 * Add one to this address's counter for the window and hand back the new total.
 *
 * ONE round trip, atomic. A read-then-write would let two concurrent requests
 * both see nine and both write ten, which is the whole class of bug the
 * `penny_turns` unique index and the promo-code claim exist to avoid — and it
 * matters more here, because concurrency is the attack.
 */
async function bumpCounter(scope: IpScope, ip: string, windowStart: number): Promise<number> {
  const [row] = await db
    .insert(ipRequestCounters)
    .values({ scope, ip, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [ipRequestCounters.scope, ipRequestCounters.ip, ipRequestCounters.windowStart],
      set: {
        count: sql`${ipRequestCounters.count} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning({ count: ipRequestCounters.count });
  return row?.count ?? 1;
}

/** Drop counters nothing will read again. Never throws; never blocks a request. */
export async function pruneIpCounters(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - IP_COUNTER_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    const rows = await db
      .delete(ipRequestCounters)
      .where(lt(ipRequestCounters.updatedAt, cutoff))
      .returning({ ip: ipRequestCounters.ip });
    return rows.length;
  } catch (err) {
    console.error('[ipLimit] prune failed', err);
    return 0;
  }
}

export interface IpCheck extends IpLimitVerdict {
  ip: string | null;
  /** Why this request was not counted, when it was not. */
  exempt: 'no_address' | 'test_runner' | 'admin' | null;
}

/**
 * Count this request against its address and say whether it may proceed.
 *
 * Exemptions, all three deliberate:
 *
 *  - **No address.** A direct local request or a server action outside a
 *    request scope. Not counted and not blocked — bucketing every anonymous
 *    caller into one shared counter would fill it and lock out everybody.
 *  - **The test runner.** Playwright and Maestro sign in dozens of fixture
 *    accounts from ONE runner address, which is exactly the shape this refuses.
 *    Gated on `isTestRequestAuthorizedByHeaders`, which is hard-off when
 *    `VERCEL_ENV === 'production'` with no override env var — unit-enforced in
 *    `test-endpoints.test.ts`, and asserted again from this side.
 *  - **Admins.** The operator debugging a flood must not be locked out by it.
 *
 * FAILS OPEN on a database error, and this is the one place in the lockdown
 * work that does. The counter write is the only reason this touches the
 * database at all, so a failure here says nothing about whether the app is
 * under attack — and the global circuit breaker, which fails CLOSED, is still
 * in front of everything that spends money. Refusing real drivers because a
 * counter table hiccuped would buy nothing that the breaker is not already
 * buying.
 */
export async function checkIpLimit(
  scope: IpScope,
  opts: { isAdmin?: boolean; nowMs?: number } = {}
): Promise<IpCheck> {
  const spec = limitFor(scope);
  const nowMs = opts.nowMs ?? Date.now();
  const base = { blocked: false, retryAfterSeconds: 0, count: 0, max: spec.max };

  const get = await headerReader();
  const ip = clientIpFromHeaders(get);
  if (!ip) return { ...base, ip: null, exempt: 'no_address' };
  if (isTestRequestAuthorizedByHeaders(get)) return { ...base, ip, exempt: 'test_runner' };
  if (opts.isAdmin) return { ...base, ip, exempt: 'admin' };

  try {
    const count = await bumpCounter(scope, ip, windowStartMs(nowMs, spec.windowHours));
    if (Math.random() * PRUNE_ONE_IN < 1) void pruneIpCounters();
    return { ...decideIpLimit({ count, spec, nowMs }), ip, exempt: null };
  } catch (err) {
    // Fails OPEN. See the note above — this is the deliberate exception.
    console.error('[ipLimit] could not count the request; allowing it', { scope, err });
    return { ...base, ip, exempt: null };
  }
}

/** `checkIpLimit`, but throws the 429 instead of returning it. */
export async function assertIpAllowed(
  scope: IpScope,
  opts: { isAdmin?: boolean; nowMs?: number } = {}
): Promise<void> {
  const check = await checkIpLimit(scope, opts);
  if (!check.blocked) return;
  throw new TooManyRequestsError(scope, check.retryAfterSeconds);
}

/**
 * Addresses that hit a limit recently — the admin panel's "IP limits hit"
 * figure. Reads the same rows the gate writes; nothing new is recorded for it.
 */
export async function recentIpLimitHits(
  hours = 24,
  now = new Date()
): Promise<Array<{ scope: string; ip: string; count: number; max: number }>> {
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const rows = await db
    .select({
      scope: ipRequestCounters.scope,
      ip: ipRequestCounters.ip,
      count: ipRequestCounters.count,
    })
    .from(ipRequestCounters)
    .where(gte(ipRequestCounters.updatedAt, since))
    .orderBy(sql`${ipRequestCounters.count} DESC`)
    .limit(200);
  return rows
    .map((r) => ({ ...r, max: limitFor(r.scope as IpScope).max }))
    .filter((r) => r.count > r.max);
}

/** How many requests one address has made in the current window. Admin only. */
export async function ipCounterFor(
  scope: IpScope,
  ip: string,
  nowMs = Date.now()
): Promise<number> {
  const spec = limitFor(scope);
  const [row] = await db
    .select({ count: ipRequestCounters.count })
    .from(ipRequestCounters)
    .where(
      and(
        eq(ipRequestCounters.scope, scope),
        eq(ipRequestCounters.ip, ip),
        eq(ipRequestCounters.windowStart, windowStartMs(nowMs, spec.windowHours))
      )
    )
    .limit(1);
  return row?.count ?? 0;
}
