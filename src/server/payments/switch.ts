import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { appMeta } from '@/server/db/schema';
import { areTestEndpointsEnabled } from '@/server/auth/test-endpoints';

/**
 * The paywall's master switch. OFF unless it has been turned on deliberately.
 *
 * Default-off, and it is the default that matters. Merging the paywall PR
 * deployed it, and deploying it blocked 28 of 29 production accounts in the
 * same instant — everyone who had signed up more than seven days earlier,
 * which by then was everyone. None of them had been told a trial existed, and
 * with no App Store app there was no way for any of them to pay their way out.
 * The code was doing exactly what it was written to do.
 *
 * So enforcement is a thing you turn ON, once there is something to buy.
 *
 * ── Why it moved out of the environment (2026-09-02) ──
 *
 * It was `PAYWALL_ENABLED=1` in Vercel. That worked, and it had two problems
 * that only show up at the moment you actually want to use it:
 *
 *  1. **Turning it off needs a redeploy.** Env changes reach a running Next
 *     server on the next deployment, not on save — so the thing you reach for
 *     when the paywall is blocking people who should not be blocked is the
 *     slowest control in the system. A switch whose whole purpose is being
 *     flipped back in a hurry cannot take a build.
 *  2. **Nothing could see it.** `/admin` warns "PAYWALL_ENABLED is unset" in
 *     two places, and both were guesses — the browser cannot read the server's
 *     environment, so the flag was threaded down as a prop from a page that
 *     read `process.env` itself. Now there is one row and everything reads it.
 *
 * ── The cache is not an optimisation ──
 *
 * `paywallEnabled()` is called from `applySwitch`, which `getAccountVerdict`
 * calls on EVERY gated request. An uncached DB read there is a query per Penny
 * turn, per trip create, per clone, forever, for a value that changes about
 * twice a year. `CACHE_MS` is the whole design: short enough that flipping the
 * switch takes effect while you are still looking at the screen, long enough
 * that the read disappears under normal traffic.
 *
 * The cache is per-instance and Vercel runs several, so the true worst case is
 * `CACHE_MS` after the last instance's read. That is fine for this value and
 * would not be for anything security-critical — which this is not: it decides
 * whether a TRUE verdict is enforced, never what the verdict is.
 *
 * ── What it still does NOT do ──
 *
 * It does not stop the trial clock, the usage metering or the account-state
 * machine. They keep running and stay truthful — the admin panel still shows
 * that an account IS `trial_expired`. The switch decides only whether that fact
 * is allowed to block anybody, which is what makes it safe to flip on and back
 * off with no state to repair.
 */

/** The `app_meta` key. One row, one string, `'1'` for on. */
export const PAYWALL_META_KEY = 'paywall_enabled';

/**
 * How stale an answer may be. Thirty seconds: a flip is visible before you have
 * finished reading the confirmation, and a busy minute costs two reads.
 */
const CACHE_MS = 30_000;

let cached: { value: boolean; at: number } | null = null;

/** Drop the cache. Called by the writer so the admin sees their own flip. */
export function invalidatePaywallSwitch(): void {
  cached = null;
}

/**
 * Read the switch.
 *
 * FAILS CLOSED — to OFF — if the row cannot be read. That is the safe direction
 * and the asymmetry is not close: a database blip that answered "on" would
 * paywall every account until it cleared, and the recovery is another database
 * read. Answering "off" costs, at worst, a few free Penny turns.
 */
export async function paywallEnabled(now = Date.now()): Promise<boolean> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  try {
    const [row] = await db
      .select({ value: appMeta.value })
      .from(appMeta)
      .where(eq(appMeta.key, PAYWALL_META_KEY))
      .limit(1);
    const value = row?.value === '1';
    cached = { value, at: now };
    return value;
  } catch (err) {
    console.error('[payments/switch] could not read the paywall switch; treating as OFF', err);
    // Deliberately NOT cached: a failed read must not pin "off" for the next
    // thirty seconds once the database comes back.
    return false;
  }
}

/**
 * Turn it on or off. The only writer.
 *
 * `updatedBy` is not stored — `app_meta` is a key/value table with nowhere to
 * put it — so the caller logs it. `/api/admin/paywall` writes a `usage_events`
 * row, which is what makes "who turned the paywall on, and when" answerable
 * later. That question WILL be asked the first time somebody is blocked
 * unexpectedly.
 */
export async function setPaywallEnabled(on: boolean): Promise<void> {
  await db
    .insert(appMeta)
    .values({ key: PAYWALL_META_KEY, value: on ? '1' : '0' })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: on ? '1' : '0' } });
  invalidatePaywallSwitch();
}

/**
 * The pure rule, so the decision is testable without a database.
 *
 * Exists because the interesting property is not the query — it is that
 * anything other than exactly `'1'` is OFF. A `'true'`, a `'yes'`, a stray
 * space or a `null` all mean off, which is the same fail-closed direction the
 * read above takes.
 */
export function paywallEnabledFromValue(value: string | null | undefined): boolean {
  return value === '1';
}

/**
 * Does enforcement apply to THIS request?
 *
 * Pure, and separated from both reads on purpose: the interesting property is
 * not either lookup, it is that there are exactly two ways to be enforced and
 * that neither of them can be reached by accident.
 *
 * `forcedForUser` is `users.paywall_enforced` — the per-account override that
 * lets the wall be tested on one test user while the global switch stays off
 * for the web demo. It is an OR, never an AND: turning the global switch on
 * must not require visiting every row, and the override must work while the
 * global switch is off, which is the entire reason it exists.
 *
 * There is no per-account way to be EXEMPTED here. That already exists and is
 * `users.comped`, which is read by `resolveAccountState` before this is ever
 * consulted — so a comped account is entitled whatever this returns. Do not
 * add an exemption branch to this function; it would give two places the power
 * to decide the same thing, which is the failure this module is shaped to
 * avoid.
 *
 * Both inputs are booleans the caller has already resolved, and both resolve to
 * `false` when their read failed. The fail direction is deliberate and
 * asymmetric, for the same reason `paywallEnabled()` documents: wrongly
 * answering "enforced" walls somebody who has done nothing wrong, and wrongly
 * answering "not enforced" costs a few free Penny turns.
 */
export function enforcementApplies(input: {
  globalOn: boolean;
  forcedForUser: boolean;
}): boolean {
  return input.globalOn || input.forcedForUser;
}

// ── The manual Penny lock ───────────────────────────────────────────────────

/**
 * The owner's one-tap stop: `app_meta.penny_locked = '1'` and Penny goes quiet
 * for everyone but the admin, with no deploy and no code change.
 *
 * Same shape as the paywall switch above and for the same reason — the control
 * you reach for in a hurry cannot take a build — but it FAILS IN THE OPPOSITE
 * DIRECTION, and that is the only interesting thing about it.
 *
 * `paywallEnabled()` fails to OFF because a blip that answered "on" would wall
 * innocent people while a blip that answered "off" costs a few free turns. This
 * one fails to LOCKED, because the asymmetry runs the other way: a blip that
 * answers "unlocked" is a bypass, during exactly the minutes an attack is most
 * likely to be the reason the database is struggling. And it costs almost
 * nothing to be wrong that way: a Penny turn needs the database for the trip,
 * the legs and the chat history, so a read that failed here was going to fail
 * again a line later. Refusing early just says so honestly.
 *
 * That direction is asserted in `switch.test.ts`, not left to this comment.
 */
export const PENNY_LOCK_META_KEY = 'penny_locked';

let lockCached: { value: boolean; at: number } | null = null;

/** Drop the cache. Called by the writer so the admin sees their own flip. */
export function invalidatePennyLock(): void {
  lockCached = null;
}

/** Read the lock. FAILS CLOSED — a read that throws reports LOCKED. */
export async function pennyLocked(now = Date.now()): Promise<boolean> {
  /*
   * Zero cache on a deployment with the E2E fixture endpoints on, for the same
   * reason and with the same safety argument as `breakerCheck.ts`'s `cacheMs`:
   * this is a staleness allowance, removing it makes the gate stricter, and
   * `areTestEndpointsEnabled()` is hard-off on production. The paywall switch
   * above deliberately keeps its cache — nothing needs it to be instant, and it
   * is not in the money path.
   */
  const ttl = areTestEndpointsEnabled() ? 0 : CACHE_MS;
  if (lockCached && now - lockCached.at < ttl) return lockCached.value;
  try {
    const [row] = await db
      .select({ value: appMeta.value })
      .from(appMeta)
      .where(eq(appMeta.key, PENNY_LOCK_META_KEY))
      .limit(1);
    const value = pennyLockedFromValue(row?.value);
    lockCached = { value, at: now };
    return value;
  } catch (err) {
    console.error('[payments/switch] could not read the Penny lock; treating as LOCKED', err);
    // Deliberately NOT cached: a failed read must not pin the app shut for the
    // next thirty seconds once the database comes back.
    return true;
  }
}

/**
 * Throw or clear the lock. The only writer.
 *
 * `flippedBy` is not stored — `app_meta` has nowhere to put it — so
 * `/api/admin/penny-lock` writes the `usage_events` row, exactly as the paywall
 * switch does. "Who closed the app, and when" is the first question asked
 * afterwards.
 */
export async function setPennyLocked(locked: boolean): Promise<void> {
  await db
    .insert(appMeta)
    .values({ key: PENNY_LOCK_META_KEY, value: locked ? '1' : '0' })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: locked ? '1' : '0' } });
  invalidatePennyLock();
}

/**
 * The pure rule. Anything other than exactly `'1'` is unlocked — including a
 * missing row, which is the default state of a deployment that has never been
 * locked. Same "one exact string" discipline as `paywallEnabledFromValue`,
 * pointing the other way.
 */
export function pennyLockedFromValue(value: string | null | undefined): boolean {
  return value === '1';
}
