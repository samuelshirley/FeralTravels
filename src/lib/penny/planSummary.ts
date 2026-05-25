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
 * day counts, dates, totals, deadline check — is computed here from the legs as
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
import { constraintLocalDateISO, constraintLocalTimeHHMM, daysBetweenISO } from '@/lib/dates';
import {
  DEFAULT_DAY_MODEL_CONFIG,
  canArriveSameDay,
  computeArrivalTime,
} from '@/lib/dayModel';
import type { LegWithDetails } from '@/types/trip';
import type { PlanSummary, PlanSummaryDeadline } from '@/types/trip';

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
    deadline: computeDeadline(legs, lastDrive),
  };
}

/**
 * Surface an arrive_by deadline as a date-only comparison against the planned
 * arrival. Prefers a constraint on the final driving leg (the arrival); falls
 * back to the latest drive leg that carries one. We never compare clock times —
 * the plan has no time model — so a same-day arrival reports `same_day`, not a
 * claim that we beat the hour.
 */
function computeDeadline(
  legs: LegWithDetails[],
  lastDrive: LegWithDetails | null,
): PlanSummaryDeadline | null {
  const arriveByOn = (leg: LegWithDetails | null) =>
    leg?.constraints.find(
      (c) => c.constraint_type === 'arrive_by' && c.constraint_datetime != null,
    ) ?? null;

  // Prefer the arrival leg's own deadline; otherwise the latest drive that has
  // one (route order).
  let constraint = arriveByOn(lastDrive);
  if (!constraint) {
    for (let i = legs.length - 1; i >= 0; i--) {
      if (legs[i].leg_type !== 'drive') continue;
      const c = arriveByOn(legs[i]);
      if (c) {
        constraint = c;
        break;
      }
    }
  }
  if (!constraint || constraint.constraint_datetime == null) return null;

  const deadlineDateISO = constraintLocalDateISO(constraint.constraint_datetime);
  const localTime = constraintLocalTimeHHMM(constraint.constraint_datetime);
  const arrivalDateISO = lastDrive?.date_iso ?? null;
  const buffer_days = daysBetweenISO(arrivalDateISO, deadlineDateISO);

  let status: PlanSummaryDeadline['status'] = 'same_day';
  if (buffer_days != null) {
    if (buffer_days > 0) status = 'before';
    else if (buffer_days < 0) status = 'after';
    else status = 'same_day';
  }

  // Time-of-day check only matters when the drive lands on the deadline DAY and
  // we know both clocks. canArriveSameDay returns slack AFTER subtracting the
  // 1h buffer, so raw slack = its slack + buffer; it clears the buffer when its
  // own feasible flag is true.
  let same_day_clock: PlanSummaryDeadline['same_day_clock'] = null;
  if (
    status === 'same_day' &&
    localTime != null &&
    lastDrive?.drive_time_minutes != null
  ) {
    const check = canArriveSameDay(
      lastDrive.drive_time_minutes,
      localTime,
      DEADLINE_BUFFER_MINUTES,
    );
    same_day_clock = {
      eta: check.arrivalTime,
      slack_minutes: check.slackMinutes + DEADLINE_BUFFER_MINUTES,
      clears_buffer: check.feasible,
    };
  }

  return {
    datetime_iso: constraint.constraint_datetime,
    date_iso: deadlineDateISO,
    local_time: localTime,
    status,
    buffer_days,
    same_day_clock,
  };
}
