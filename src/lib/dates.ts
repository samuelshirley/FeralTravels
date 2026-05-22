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
 */
export function legDate(
  tripStartISO: string | null | undefined,
  legIndex: number,
  units: UnitsPref,
): string | null {
  if (!tripStartISO) return null;
  const start = parseISODate(tripStartISO);
  const date = addDays(start, legIndex);
  return formatDate(date, units);
}
