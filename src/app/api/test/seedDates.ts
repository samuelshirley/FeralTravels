import { legDateISO, todayISOInZone } from '@/lib/dates';

/**
 * The one rule every seeded / fixture trip follows: it starts a FIXED OFFSET
 * IN THE FUTURE, computed at seed time. Import this — never restate the
 * number, and never write a calendar date into a fixture.
 *
 * Why an offset instead of a date: a hardcoded date is future-dated on the day
 * someone types it and silently becomes a PAST trip a few months later, long
 * after they have stopped thinking about it. A past-dated trip is a different
 * product state, not a cosmetic difference — `behindCutoffRank`
 * (src/lib/dates.ts) folds its days into the collapsed "behind you" section,
 * `LegCard` deliberately suppresses lazy fuel sourcing for past days, and the
 * nav links point at the wrong leg. So a spec about the PLANNING flow starts
 * failing for a reason that has nothing to do with the code under test, and
 * the failure looks like an app bug.
 *
 * Why 14 and not 0: a trip starting "today" sits exactly on the behind/ahead
 * boundary, and that boundary is the one thing this codebase already knows is
 * ambiguous — the server runs UTC while the browser collapses days in the
 * driver's own zone, which is the entire reason `todayISOInZone` exists. Two
 * weeks clears that seam, and clears it for the trip's whole tail: a
 * multi-day seeded itinerary still has every day ahead of the driver.
 */
export const SEEDED_TRIP_START_OFFSET_DAYS = 14;

/**
 * The start date every seeded trip gets: today + {@link
 * SEEDED_TRIP_START_OFFSET_DAYS}, as ISO "YYYY-MM-DD".
 *
 * `timeZone` is threaded through `todayISOInZone` rather than reading a bare
 * `new Date()`, for the same reason trip logic does everywhere else. Seeding
 * runs server-side (UTC on Vercel) and defaults to that, which is fine here:
 * a 14-day cushion cannot be crossed by a one-day zone disagreement. `now`
 * and `timeZone` are parameters so the guard test can describe a moment
 * instead of waiting for one.
 */
export function seededTripStartISO(
  now: Date = new Date(),
  timeZone: string | null = null,
): string {
  return legDateISO(todayISOInZone(timeZone, now), SEEDED_TRIP_START_OFFSET_DAYS);
}

/**
 * The date for leg `legIndex` of a seeded trip — one calendar day per leg,
 * the same rule `getTripFull` re-anchors real legs with (`legDateISO`).
 */
export function seededLegDateISO(
  legIndex: number,
  now: Date = new Date(),
  timeZone: string | null = null,
): string {
  return legDateISO(seededTripStartISO(now, timeZone), legIndex);
}
