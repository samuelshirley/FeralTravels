/**
 * planSummary.ts — the deterministic plan summarizer.
 *
 * This is the answer to a specific failure mode: Penny narrates a plan in the
 * SAME model turn that emits her tool calls, so her prose describes the plan she
 * *intended* before the server actually computes and persists it (rest-day
 * counts, leg ordering, calendar dates). The result was confident, wrong facts
 * — invented arrival times ("1:47pm"), miscounted nights ("2 instead of 3"),
 * off-by-one arrival dates.
 *
 * The fix: Penny is a conversational wrapper only. Every NUMBER the user sees —
 * day counts, dates, totals — is computed here from the legs as
 * they actually landed in the DB (after `rebuildTripSchedule`), never authored
 * by the model. If the LLM can't state the number, it can't hallucinate it.
 *
 * Pure function, no I/O — unit-testable. The async wrapper that loads the trip
 * and calls this lives at the dispatch site (api/trip/replan). Mirrors the
 * split used by `schedule.ts` / `rebuildTripSchedule`.
 *
 * DATE MODEL (shared with schedule.ts): every leg — drive or rest — occupies
 * exactly one calendar day, so a leg's date is `trip start + its rank`. We do
 * NOT model clock time anywhere, which is why the deadline check is date-only.
 */
import { daysBetweenISO } from '@/lib/dates';
import {
  DEFAULT_DAY_MODEL_CONFIG,
  canArriveSameDay,
  computeArrivalTime,
} from '@/lib/dayModel';
import type { LegWithDetails } from '@/types/trip';
import type { PlanSummary } from '@/types/trip';

/** Buffer the deadline check wants cleared (minutes). Mirrors dayModel default. */
const DEADLINE_BUFFER_MINUTES = 60;

export interface ComputePlanSummaryInput {
  /** Trip legs in route/sort order, exactly as returned by `getTripFull`. */
  legs: LegWithDetails[];
  /** Trip `start_date_parsed` ("YYYY-MM-DD") — used only for the deadline diff. */
  tripStartISO: string | null;
}

/**
 * Build a purely factual plan summary from the persisted legs.
 *
 * Returns null when there are no legs (nothing to summarize) — callers treat
 * that as "don't attach a summary card to this turn".
 */
export function computePlanSummary(
  input: ComputePlanSummaryInput,
): PlanSummary | null {
  const legs = input.legs;
  if (legs.length === 0) return null;

  const driveLegs = legs.filter((l) => l.leg_type === 'drive');
  const restLegs = legs.filter((l) => l.leg_type === 'rest');

  const firstLeg = legs[0];
  const firstDrive = driveLegs[0] ?? null;
  const lastDrive = driveLegs.length > 0 ? driveLegs[driveLegs.length - 1] : null;

  const total_distance_km = driveLegs.reduce(
    (sum, l) => sum + (l.distance_km ?? 0),
    0,
  );
  const total_drive_minutes = driveLegs.reduce(
    (sum, l) => sum + (l.drive_time_minutes ?? 0),
    0,
  );

  // Nights per stop: a "stop" is one drive leg plus the rest days that follow
  // it at the same destination (the schedule.ts model). Walk the ordered legs,
  // count the rest legs between consecutive drives, and attribute them to the
  // drive's destination. Only surface stops with >= 1 night to keep the card
  // high-level — a 0-night overnight is just where a drive day ended.
  const nights_per_stop: Array<{ name: string | null; nights: number }> = [];
  for (let i = 0; i < legs.length; i++) {
    if (legs[i].leg_type !== 'drive') continue;
    let nights = 0;
    for (let j = i + 1; j < legs.length && legs[j].leg_type === 'rest'; j++) {
      nights++;
    }
    if (nights > 0) {
      nights_per_stop.push({ name: legs[i].end_name ?? null, nights });
    }
  }

  // Clock-time estimate. The plan stores no per-leg times, so we surface the
  // day-model default: leave at 08:00 each driving day; the final leg's ETA is
  // departure + drive + realistic breaks. These are ESTIMATES, labelled as such
  // in the UI — not stored facts.
  const depart_time = firstDrive ? DEFAULT_DAY_MODEL_CONFIG.typicalDepartureTime : null;
  const arrive_time =
    lastDrive?.drive_time_minutes != null
      ? computeArrivalTime(lastDrive.drive_time_minutes).arrivalTime
      : null;

  return {
    total_days: legs.length,
    drive_days: driveLegs.length,
    rest_days: restLegs.length,
    depart_date_iso: firstLeg.date_iso ?? null,
    depart_name: (firstDrive ?? firstLeg).start_name ?? null,
    arrive_date_iso: lastDrive?.date_iso ?? null,
    arrive_name: lastDrive?.end_name ?? null,
    depart_time,
    arrive_time,
    total_distance_km,
    total_drive_minutes,
    nights_per_stop,
  };
}

