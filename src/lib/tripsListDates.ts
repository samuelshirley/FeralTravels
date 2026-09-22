/**
 * The trips list's date headers, and the one question under them: has this
 * trip actually been given a start date yet?
 *
 * Shared (mirrored to mobile/shared/lib by sync-shared) so the web list and the
 * native list cannot disagree about which trips sit under which header.
 */

import type { OnboardingState, OnboardingScan } from '@/types/trip';
import { formatDayMonthYear } from '@/lib/dates';

/**
 * Whether `start_date_parsed` holds a date the driver gave, rather than the
 * today placeholder `createTrip` seeds so the column is never null.
 *
 * Looked at before it was written, 2026-09-22: a first-run trip left at the
 * opening question shows on the trips list with `start_date_parsed` = today.
 * Without this it would sit under a header claiming the driver picked today.
 *
 * The date is written in exactly two places, both in server/onboarding.ts: the
 * opening-message scan (which records `date_skipped` and may still stop at
 * `trip_origin` to ask where from), and the `trip_date` answer, which always
 * moves the trip past `trip_date`. So the placeholder is live only before
 * either has happened.
 */
export function isStartDateAnswered(
  state: OnboardingState,
  scan: OnboardingScan | null | undefined,
): boolean {
  if (state === 'not_started' || state === 'trip_intent' || state === 'trip_date') return false;
  if (state === 'trip_origin') return scan?.date_skipped === true;
  return true;
}

/**
 * "08 Oct 2026 → 21 Oct 2026" for a trip header (the itinerary's meta line).
 * Reads the machine columns only — never the free-text `start_date` /
 * `end_date`, which hold whatever the driver typed ("On October 12"). Empty
 * string while the start is still the placeholder, so the caller's
 * `.filter(Boolean)` drops it.
 */
export function formatTripDateRange(trip: {
  start_date_parsed: string;
  end_date_parsed: string | null;
  start_date_set?: boolean;
}): string {
  if (trip.start_date_set === false) return '';
  const start = formatDayMonthYear(trip.start_date_parsed);
  const end = trip.end_date_parsed ? formatDayMonthYear(trip.end_date_parsed) : null;
  return [start, end && end !== start ? end : null].filter(Boolean).join(' → ');
}
