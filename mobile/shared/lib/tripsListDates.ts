/**
 * The trips list's date headers, and the one question under them: has this
 * trip actually been given a start date yet?
 *
 * Shared (mirrored to mobile/shared/lib by sync-shared) so the web list and the
 * native list cannot disagree about which trips sit under which header.
 */

import type { OnboardingState, OnboardingScan } from '../types/trip';
import { formatDayMonthYear } from '../lib/dates';

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

export interface DateGroup<T> {
  /** Stable React key for the header row. */
  key: string;
  /** "16 Sep 2026", or null for a run of trips with no date to show. */
  label: string | null;
  trips: T[];
}

/**
 * One header per run of CONSECUTIVE trips sharing a start date — the list
 * arrives ordered by start date already (listTripsForUser), so a run is a day.
 * Trips whose date has not been answered form their own header-less runs.
 */
export function groupByStartDate<
  T extends { id: string; start_date_parsed: string; start_date_set?: boolean },
>(trips: T[]): DateGroup<T>[] {
  const groups: DateGroup<T>[] = [];
  for (const trip of trips) {
    const label = trip.start_date_set === false ? null : formatDayMonthYear(trip.start_date_parsed);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.trips.push(trip);
    else groups.push({ key: `date-${label ?? 'none'}-${trip.id}`, label, trips: [trip] });
  }
  return groups;
}

/**
 * The trip the driver was last in. The list is ordered by start date, so its
 * head is no longer that trip — callers that send a blocked driver back to
 * "their" chat ask this instead. Falls back to list order when the payload
 * carries no activity timestamp.
 */
export function mostRecentlyActive<T extends { last_activity_at?: string | null }>(
  trips: T[],
): T | undefined {
  let best: T | undefined;
  for (const t of trips) {
    if (!best) best = t;
    else if ((t.last_activity_at ?? '') > (best.last_activity_at ?? '')) best = t;
  }
  return best;
}
