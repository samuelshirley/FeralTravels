import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { appMeta } from '@/server/db/schema';

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
