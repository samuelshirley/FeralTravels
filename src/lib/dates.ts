/**
 * Date formatting helpers — client-safe (no `server-only` import).
 *
 * The DB stores trip start dates as ISO "YYYY-MM-DD" in `start_date_parsed`.
 * Leg dates are derived at render time from the trip start date + the leg's
 * position in the array (each leg = one calendar day).
 *
 * Display format depends on the user's units preference:
 *   metric   → "Wed 28 May"   (day-first, the rest of the world)
 *   imperial → "Wed May 28"   (month-first, the American way)
 *
 * Uses Intl.DateTimeFormat — no external date library needed.
 */

import type { UnitsPref } from './units';

/**
 * Try to extract an ISO "YYYY-MM-DD" string from a free-text date.
 *
 * Handles the formats we actually encounter:
 *   - ISO:       "2026-05-28"
 *   - US text:   "May 28, 2026"  /  "May 28 2026"
 *   - EU text:   "28 May 2026"
 *   - Slash:     "05/28/2026"  /  "5/28/2026"
 *   - Compact:   "Jun 12-13" → takes the first date (day 12)
 *
 * Returns null when the string can't be parsed into a valid date.
 * This is intentionally lenient — a null return just means leg dates
 * stay as "Day 1" / "Day 2" until a parseable date is provided.
 */
export function tryParseToISO(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Already ISO? Validate and return.
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const d = new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]);
    if (!isNaN(d.getTime())) {
      return toISO(d);
    }
  }

  // Fallback: let Date.parse have a go. It handles "May 28, 2026" etc.
  const ms = Date.parse(trimmed);
  if (!isNaN(ms)) {
    // Date.parse returns UTC — build a local date from the UTC parts to
    // avoid timezone-shift day rollback.
    const utc = new Date(ms);
    const d = new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
    if (!isNaN(d.getTime()) && d.getFullYear() >= 2000 && d.getFullYear() <= 2100) {
      return toISO(d);
    }
  }

  return null;
}

/** Format a Date as "YYYY-MM-DD". */
function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Parse an ISO "YYYY-MM-DD" string into a local-midnight Date without
 * timezone shift. `new Date("2026-05-28")` parses as UTC midnight which
 * can roll back a day in negative-offset timezones — avoid that.
 */
export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Add `days` calendar days to a Date (returns a new Date).
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Format a Date for display based on the user's unit preference.
 *
 *   metric   → "Wed 28 May"
 *   imperial → "Wed May 28"
 *
 * Uses Intl.DateTimeFormat.formatToParts for precise control over order,
 * stripping any commas Intl wants to insert.
 */
export function formatDate(date: Date, units: UnitsPref): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).formatToParts(date);

  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';

  if (units === 'imperial') {
    return `${weekday} ${month} ${day}`;
  }
  return `${weekday} ${day} ${month}`;
}

/**
 * Compute the formatted date string for a leg given:
 *   - tripStartISO: the trip's `start_date_parsed` ("YYYY-MM-DD"), or null
 *   - legIndex: 0-based position in the sorted legs array
 *   - units: user's display preference
 *
 * Returns null when startDateParsed is not set (trip hasn't confirmed dates).
 *
 * NOTE: This is a *presentation* helper — formatting an already-decided date.
 * The decision of WHICH calendar date a leg falls on is domain logic and now
 * lives server-side ({@link legDateISO}, called from the trips repo + Penny
 * context). Prefer formatting a server-provided `date_iso` over recomputing
 * the date on the client.
 */
export function legDate(
  tripStartISO: string | null | undefined,
  legIndex: number,
  units: UnitsPref,
): string | null {
  const iso = legDateISO(tripStartISO, legIndex);
  if (!iso) return null;
  return formatDate(parseISODate(iso), units);
}

// ---------------------------------------------------------------------------
// Domain logic: calendar-date assignment + constraint scheduling.
//
// These are pure functions (no I/O, no `server-only`) so they can be unit
// tested and shared between the server (date assignment, feasibility,
// dispatch enforcement) and — for display formatting only — the client.
//
// THE DATE MODEL: every leg (driving OR rest) occupies exactly one calendar
// day. A leg's date is therefore `trip.start_date_parsed + its 0-based rank`
// in the sort_order-sorted leg list. Rest-day legs are the only lever that
// shifts a later leg's date without adding driving — which is why honoring a
// fixed date ("leave on the 3rd") reduces to inserting the right number of
// rest legs before the anchored leg.
// ---------------------------------------------------------------------------

/**
 * The ISO "YYYY-MM-DD" calendar date a leg falls on, given the trip start
 * date and the leg's 0-based rank in the sorted leg list. This is the
 * server-side source of truth for leg dates; the client formats the result.
 *
 * Returns null when the trip start date isn't set yet.
 */
export function legDateISO(
  tripStartISO: string | null | undefined,
  legIndex: number,
): string | null {
  if (!tripStartISO) return null;
  const start = parseISODate(tripStartISO);
  if (isNaN(start.getTime())) return null;
  return toISO(addDays(start, legIndex));
}

/**
 * Whole calendar days from `fromISO` to `toISO` (i.e. `to - from`). Negative
 * when `to` precedes `from`. Both inputs are "YYYY-MM-DD". Returns null when
 * either side can't be parsed.
 */
export function daysBetweenISO(
  fromISO: string | null | undefined,
  toISO: string | null | undefined,
): number | null {
  if (!fromISO || !toISO) return null;
  const a = parseISODate(fromISO);
  const b = parseISODate(toISO);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  // Both are local-midnight dates, so a plain ms difference is exact.
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * Extract the *local* calendar date ("YYYY-MM-DD") from a constraint datetime.
 *
 * Constraint datetimes are authored as ISO 8601 with an explicit offset, e.g.
 * "2026-06-03T08:00:00+02:00". The local date is the calendar day the user
 * means ("the morning of the 3rd"), so we take the date prefix directly rather
 * than routing through `new Date()` — which would convert to the runtime's
 * timezone and can roll the day backward/forward.
 *
 * Falls back to {@link tryParseToISO} for looser inputs ("June 3, 2026").
 */
export function constraintLocalDateISO(
  datetime: string | null | undefined,
): string | null {
  if (!datetime) return null;
  const trimmed = datetime.trim();
  const prefix = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/);
  if (prefix) {
    const iso = `${prefix[1]}-${prefix[2]}-${prefix[3]}`;
    // Validate it's a real date.
    const d = parseISODate(iso);
    if (!isNaN(d.getTime())) return iso;
  }
  return tryParseToISO(trimmed);
}

/**
 * Extract the *local* wall-clock time ("HH:MM") from a constraint datetime.
 *
 * Constraint datetimes are authored as ISO 8601 with an explicit offset, e.g.
 * "2026-06-03T15:00:00+02:00" — the local time is "the morning/afternoon the
 * user means" ("by 3pm"), so we read the HH:MM directly from the string rather
 * than via `new Date()`, which would convert to the runtime's timezone. Returns
 * null when there's no time component (date-only constraints).
 */
export function constraintLocalTimeHHMM(
  datetime: string | null | undefined,
): string | null {
  if (!datetime) return null;
  const m = datetime.trim().match(/[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

/**
 * Given a fixed calendar date that a specific leg must fall on, compute how
 * many rest-day legs must sit *before* that leg.
 *
 * The anchored leg's required rank = (targetDate − tripStart) in days. Of the
 * legs before it, `driveDaysBefore` are immovable driving days (fixed by the
 * route), so the remaining slots must be rest days:
 *
 *   requiredRestDaysBefore = (targetDate − tripStart) − driveDaysBefore
 *
 * A negative result means the date is physically too early — the driving
 * alone overruns it — i.e. genuinely infeasible. Returns null when inputs
 * can't be parsed.
 */
export function requiredRestDaysBefore(args: {
  tripStartISO: string | null | undefined;
  targetDateISO: string | null | undefined;
  driveDaysBefore: number;
}): number | null {
  const span = daysBetweenISO(args.tripStartISO, args.targetDateISO);
  if (span == null) return null;
  return span - args.driveDaysBefore;
}
