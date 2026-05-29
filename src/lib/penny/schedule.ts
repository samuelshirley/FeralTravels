/**
 * schedule.ts — the deterministic trip scheduler.
 *
 * This is the server's source of truth for HOW MANY rest days a trip has and in
 * WHAT ORDER its legs fall. It exists because the old model made the LLM
 * responsible for both: Penny had to emit the right number of rest-day legs, in
 * the right positions, to make the positional date model (date = trip start +
 * leg rank) line up with fixed dates the user gave ("be in X by the 3rd").
 * Under edits she mismanaged the count (1 rest day instead of 3) and the order
 * (a rest day appended AFTER the drive it was supposed to precede). Moving the
 * math here removes both failure modes.
 *
 * THE MODEL: every leg — driving or rest — occupies exactly one calendar day.
 * A "stop" is one driving leg plus the (zero or more) rest days spent at its
 * destination afterward. Given the trip start date and the ordered stops, the
 * full leg list and each leg's calendar date are fully determined. A stop with
 * a fixed-date anchor pins its driving leg to a calendar day; we expand or
 * contract the rest days BEFORE that drive so it lands on the right day.
 *
 * Pure functions only — no I/O, no DB, no 'server-only'. The DB reconciliation
 * that turns this output into leg rows lives in the trips repo
 * (rebuildTripSchedule); keeping the math here makes it unit-testable.
 */
import { legDateISO, daysBetweenISO } from '@/lib/dates';

/**
 * One stop = a driving leg + the stay at its destination. In route order, so
 * stops[0] is the first drive out of the origin and the last entry is the drive
 * into the final destination.
 */
export interface ScheduleStop {
  /** Existing leg id of the driving leg that ARRIVES at this stop. */
  driveId: string;
  endName: string | null;
  endLat: number | null;
  endLng: number | null;
  /**
   * Nights the user wants to stay here when nothing forces otherwise (>= 0).
   * A pure overnight you leave the next morning is 0 (it's just where a drive
   * day ends); a multi-night stay is >= 1.
   */
  desiredNights: number;
  /**
   * If this stop's DRIVING leg must occur on a specific calendar day, the ISO
   * "YYYY-MM-DD" of that day. Maps from a dated arrive_by/depart_after
   * constraint on the drive. Null/undefined for unconstrained stops.
   */
  anchorDateISO?: string | null;
}

export interface ScheduleInput {
  /** Trip start date, ISO "YYYY-MM-DD". The first drive falls on this day. */
  tripStartISO: string;
  /** Stops in route order. */
  stops: ScheduleStop[];
}

export interface MaterializedLeg {
  kind: 'drive' | 'rest';
  /** Set for kind === 'drive': the existing drive leg id. */
  driveId?: string;
  /** Index into stops[] this leg belongs to (its destination / stay). */
  stopIndex: number;
  /** 0-based position in the final ordered leg list. */
  rank: number;
  /** Calendar date, ISO "YYYY-MM-DD", or null if start date unparseable. */
  dateISO: string | null;
}

export interface ScheduleInfeasibility {
  stopIndex: number;
  anchorDateISO: string;
  reason: string;
}

export interface ScheduleResult {
  /** The full ordered leg list (drives interleaved with their rest days). */
  legs: MaterializedLeg[];
  /** Final nights allocated at each stop (index-aligned with input stops). */
  nightsPerStop: number[];
  /** Stops whose fixed date can't be met (the driving alone overruns it). */
  infeasible: ScheduleInfeasibility[];
}

/**
 * Resolve nights and ordering for a trip.
 *
 * Strategy:
 *   1. Start from each stop's desiredNights.
 *   2. For each anchored stop (in route order), the rank of its driving leg is
 *      `drivesBefore + restsBefore`. drivesBefore is fixed by the route, so the
 *      rests BEFORE that drive must equal `(anchorDate - tripStart) - driveIndex`.
 *      Adjust the nights of the stops before it (nearest-first) to hit that.
 *   3. Emit drives interleaved with their rest days, numbering ranks 0..N-1 and
 *      stamping each leg's calendar date.
 */
export function materializeSchedule(input: ScheduleInput): ScheduleResult {
  const stops = input.stops;
  const nights = stops.map((s) => Math.max(0, Math.floor(s.desiredNights)));
  const infeasible: ScheduleInfeasibility[] = [];

  for (let i = 0; i < stops.length; i++) {
    const anchorISO = stops[i].anchorDateISO;
    if (!anchorISO) continue;

    const requiredRank = daysBetweenISO(input.tripStartISO, anchorISO);
    if (requiredRank == null) continue; // unparseable — leave as-is

    // driveIndex i means there are `i` driving legs before this drive.
    const targetRestsBefore = requiredRank - i;
    if (targetRestsBefore < 0) {
      infeasible.push({
        stopIndex: i,
        anchorDateISO: anchorISO,
        reason: `Fixed date ${anchorISO} is too early: ${i} driving day(s) before this stop overrun it by ${-targetRestsBefore} day(s).`,
      });
      continue;
    }

    const currentRestsBefore = sumNights(nights, 0, i); // nights[0..i-1]
    let delta = targetRestsBefore - currentRestsBefore;
    if (delta === 0) continue;

    // Apply delta to the stops before the anchor, nearest-first (the stop right
    // before the anchored drive absorbs slack first, then cascade backward).
    for (let j = i - 1; j >= 0 && delta !== 0; j--) {
      if (delta > 0) {
        nights[j] += delta;
        delta = 0;
      } else {
        const reducible = Math.min(nights[j], -delta);
        nights[j] -= reducible;
        delta += reducible;
      }
    }
    // delta != 0 here would mean we couldn't remove enough rest days to pull the
    // drive earlier — but targetRestsBefore >= 0 guarantees a valid non-negative
    // allocation exists, so any leftover is a removal we satisfy by leaving the
    // earliest stops at 0. (delta > 0 always fully applied above.)
  }

  // Emit the ordered leg list.
  const legs: MaterializedLeg[] = [];
  let rank = 0;
  for (let i = 0; i < stops.length; i++) {
    legs.push({
      kind: 'drive',
      driveId: stops[i].driveId,
      stopIndex: i,
      rank,
      dateISO: legDateISO(input.tripStartISO, rank),
    });
    rank++;
    for (let n = 0; n < nights[i]; n++) {
      legs.push({
        kind: 'rest',
        stopIndex: i,
        rank,
        dateISO: legDateISO(input.tripStartISO, rank),
      });
      rank++;
    }
  }

  return { legs, nightsPerStop: nights, infeasible };
}

/** Sum nights[from..to-1]. */
function sumNights(nights: number[], from: number, to: number): number {
  let s = 0;
  for (let k = from; k < to; k++) s += nights[k];
  return s;
}

// ---------------------------------------------------------------------------
// Route continuity
//
// materializeSchedule owns rest-day count + ordering. It does NOT own each drive
// leg's START coordinate — that was historically authored by Penny and trusted
// verbatim, which let her create a leg that begins somewhere other than where the
// previous leg ended (e.g. "Innsbruck → Nürburgring" when the traveler is
// actually sitting in Bad Kissingen). The map then drew that hole as a dashed red
// "gap" line — the "magic jump". The fix is a hard invariant: in route order,
// every leg starts where the previous one ended. We compute the corrections here
// (pure) and the trips repo re-routes + persists them.
// ---------------------------------------------------------------------------

/** A leg reduced to the fields needed to check route continuity. */
export interface ContinuityLeg {
  legType: 'drive' | 'rest';
  startLat: number | null;
  startLng: number | null;
  endLat: number | null;
  endLng: number | null;
  /** Destination name — becomes the next leg's start name when we chain. */
  endName: string | null;
}

/** A correction: the drive leg at `index` must start where the prior leg ended. */
export interface StartFix {
  /** Index into the input legs array. */
  index: number;
  startLat: number;
  startLng: number;
  startName: string | null;
}

/**
 * Below this many km, two points are "the same place" — don't churn a re-route
 * over floating-point noise or a Google-snapped endpoint a few metres off.
 */
const DEFAULT_CONTINUITY_EPSILON_KM = 1;

/**
 * Compute the start-coordinate corrections needed to make a leg list contiguous:
 * every leg after the anchor must START where the previous leg ENDED.
 *
 * Rules:
 *   - The ANCHOR leg is never corrected — its start is the chain's origin. This
 *     is normally leg 0 (the trip origin), but when the driver has reported
 *     progress it's the current leg, whose start is the driver's real position;
 *     legs before it are "behind you" and left untouched.
 *   - Only DRIVE legs are corrected. Rest legs are already pinned to their stop's
 *     coordinates by materializeSchedule / rebuildTripSchedule.
 *   - A drive leg is corrected when its start is missing, or lies more than
 *     `epsilonKm` from the previous leg's end. The previous leg may be a drive
 *     (0-night overnight) or a rest day at the prior stop — both carry the prior
 *     stop's coordinates as their end.
 *   - If the previous leg has no end coordinates we can't chain, so we skip it.
 *
 * Pure — the caller re-routes (origin = prev end) and persists.
 */
export function computeStartFixes(
  legs: ContinuityLeg[],
  epsilonKm: number = DEFAULT_CONTINUITY_EPSILON_KM,
  anchorIndex: number = 0,
): StartFix[] {
  const fixes: StartFix[] = [];
  const from = Math.max(1, anchorIndex + 1);
  for (let i = from; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.legType === 'rest') continue;
    const prev = legs[i - 1];
    if (prev.endLat == null || prev.endLng == null) continue; // can't chain
    const startMissing = leg.startLat == null || leg.startLng == null;
    const drifted =
      !startMissing &&
      haversineKm(prev.endLat, prev.endLng, leg.startLat as number, leg.startLng as number) >
        epsilonKm;
    if (startMissing || drifted) {
      fixes.push({
        index: i,
        startLat: prev.endLat,
        startLng: prev.endLng,
        startName: prev.endName,
      });
    }
  }
  return fixes;
}

/** Great-circle distance in km. Local copy to keep this module I/O-free. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
