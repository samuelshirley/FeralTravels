/**
 * Deterministic trip naming.
 *
 * Trips are created with a "New trip" placeholder (the "+ New trip" button no
 * longer asks for a name). Once a start date is known, the app auto-names the
 * trip from its dates — no LLM involvement. Short trips read as the month
 * ("June '26 Trip"); trips longer than a month read as the season ("Summer '26
 * Trip"). Seasons are northern-hemisphere — a deliberate simplification; we
 * don't derive hemisphere from coordinates.
 *
 * Pure module (no DB, no `server-only`) so the logic is unit-testable. The
 * DB-touching pieces (uniqueness probe, apply-to-trip) live in
 * `src/server/repos/trips.ts`.
 */

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Northern-hemisphere season for a 0-indexed month (0 = January). */
export function seasonForMonth(month0: number): string {
  if (month0 === 11 || month0 <= 1) return 'Winter'; // Dec, Jan, Feb
  if (month0 <= 4) return 'Spring'; // Mar, Apr, May
  if (month0 <= 7) return 'Summer'; // Jun, Jul, Aug
  return 'Fall'; // Sep, Oct, Nov
}

/** A trip is "long" (season-named instead of month-named) when it spans > ~1 month. */
const LONG_TRIP_DAYS = 31;

/**
 * Build the deterministic trip name from its parsed dates.
 *
 * @param startISO YYYY-MM-DD (the trip's start_date_parsed). Required.
 * @param endISO   YYYY-MM-DD (the trip's end_date_parsed), or null/undefined.
 * @returns e.g. "June '26 Trip" (short) or "Summer '26 Trip" (> 1 month), or
 *          null when startISO isn't a usable date.
 */
export function seasonalTripName(startISO: string, endISO?: string | null): string | null {
  const start = new Date(`${startISO}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;

  const month0 = start.getUTCMonth();
  const yy = String(start.getUTCFullYear() % 100).padStart(2, '0');

  let longTrip = false;
  if (endISO) {
    const end = new Date(`${endISO}T00:00:00Z`);
    if (!Number.isNaN(end.getTime())) {
      const days = (end.getTime() - start.getTime()) / 86_400_000;
      longTrip = days > LONG_TRIP_DAYS;
    }
  }

  const label = longTrip ? seasonForMonth(month0) : MONTH_NAMES[month0];
  return `${label} '${yy} Trip`;
}

/**
 * True when the name is still an auto-assigned placeholder we may safely
 * overwrite. A real name (set by the user or by Penny on explicit request) is
 * never a placeholder, so it's left alone.
 */
export function isPlaceholderTripName(name: string | null | undefined): boolean {
  const n = (name ?? '').trim().toLowerCase();
  return n === '' || /^new trip( \d+)?$/.test(n) || n === 'untitled trip';
}
