/**
 * When a trip is over.
 *
 * DERIVED, never stored: a trip is completed when its last calendar day is
 * already behind the driver. Nothing writes a "completed" flag — the dormant
 * `trips.trip_status` column is exactly that mistake and is unwired for a
 * reason. A stored flag needs someone to set it (a cron, a nightly replan,
 * the user), and every one of those can be wrong while the calendar cannot.
 *
 * "Today" is ALWAYS passed in, never read from the clock here. The repo has
 * shipped a day-drift bug from having two notions of today — the server runs
 * in UTC on Vercel while the driver is in their own zone — so callers resolve
 * it once through `todayISOInZone` (server, owner's zone) or `todayISO`
 * (browser, already the user's zone) and hand the result down. See dates.ts.
 */

import { legDateISO } from '@/lib/dates';

/** "YYYY-MM-DD" and nothing else — the shape every date here compares as. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The last calendar day of a trip whose leg dates are already materialized
 * (`LegWithDetails.date_iso`, assigned server-side by getTripFull). Null when
 * there are no legs, which reads as "undated" — see {@link isTripCompleted}.
 *
 * Takes the MAX rather than the last element: the legs arrive sorted by
 * sort_order and dated from that order, so the two agree, but a max can't be
 * wrong if a caller ever hands over an unsorted slice.
 */
export function lastDayFromLegDates(
  legDateISOs: readonly (string | null | undefined)[] | null | undefined,
): string | null {
  if (!legDateISOs) return null;
  let last: string | null = null;
  for (const iso of legDateISOs) {
    if (!iso || !ISO_DATE.test(iso)) continue;
    if (last === null || iso > last) last = iso;
  }
  return last;
}

/**
 * The last calendar day of a trip from its SCHEDULE — for surfaces that have
 * the trip row but not its legs (the trips list, which would otherwise need a
 * full getTripFull per card).
 *
 * Same rule getTripFull uses to date each leg: every leg (driving or rest) is
 * exactly one calendar day, so the last one falls on the effective start plus
 * `legCount - 1`. The driver's progress anchor moves that effective start —
 * when they report "I'm on day 4 today", day 4 is the anchor date and the
 * whole calendar re-hangs off it.
 *
 * `currentLegRank` is the 0-based position of `trip.current_leg_id` in the
 * sorted leg list, or -1 when there is no report or the pointer is stale (it
 * is a plain uuid with no FK, so a deleted leg leaves one behind).
 */
export function lastDayFromSchedule(args: {
  /** trip.start_date_parsed — non-null by invariant, but callers may be lax. */
  startDateISO: string | null | undefined;
  legCount: number;
  currentLegRank?: number;
  /** trip.progress_anchor_date — the date `currentLegRank`'s leg falls on. */
  progressAnchorISO?: string | null;
}): string | null {
  const { startDateISO, legCount, currentLegRank = -1, progressAnchorISO } = args;
  if (!startDateISO || !ISO_DATE.test(startDateISO)) return null;
  if (!Number.isFinite(legCount) || legCount < 1) return null;

  // Re-anchor from the report when there is one. A report always writes an
  // anchor date alongside the leg pointer (applyTripProgress), so a missing
  // one means a legacy/partial row — fall back to the trip's own start rather
  // than inventing a date from the server's clock.
  let effectiveStartISO = startDateISO;
  if (currentLegRank >= 0 && progressAnchorISO && ISO_DATE.test(progressAnchorISO)) {
    effectiveStartISO = legDateISO(progressAnchorISO, -currentLegRank);
  }
  return legDateISO(effectiveStartISO, legCount - 1);
}

/**
 * Is the trip over? True only when its last day is STRICTLY before today —
 * the day you are on is not behind you, same cutoff rule the "behind you"
 * collapse uses (behindCutoffRank).
 *
 * An undated trip (no last day, or junk where a date should be) is never
 * completed. Guessing here would put a "Completed" overlay on a trip the user
 * is still planning, which is worse than showing nothing.
 *
 * ISO "YYYY-MM-DD" strings sort as dates, so a string compare is the date
 * compare — no Date objects, and therefore no timezone to get wrong.
 */
export function isTripCompleted(
  lastDayISO: string | null | undefined,
  todayISO: string | null | undefined,
): boolean {
  if (!lastDayISO || !ISO_DATE.test(lastDayISO)) return false;
  if (!todayISO || !ISO_DATE.test(todayISO)) return false;
  return lastDayISO < todayISO;
}
