import 'server-only';
import { distanceToSegmentKm, haversineKm } from '@/lib/penny/geo';

/**
 * A leg created earlier in the CURRENT replan turn, recorded at dispatch time.
 *
 * New legs are written to the DB only when the validated plan is applied, so
 * Penny never sees their real UUID during the model loop — when she wants to
 * attach a stop or route to one she invents a leg_id that doesn't resolve.
 * `pickNearestNewLeg` maps that invented id onto one of these real records.
 */
export type NewLegRecord = {
  id: string;
  startLat: number | null;
  startLng: number | null;
  endLat: number | null;
  endLng: number | null;
};

/**
 * Choose which same-turn new leg a stop/route belongs to when its proposed
 * leg_id didn't resolve to a real leg.
 *
 * Geometry-first: when the item carries a coordinate, pick the new leg whose
 * start↔end corridor it's closest to — this lands the stop on the RIGHT new
 * leg even when several were created this turn. With no coordinate (or no new
 * leg has coordinates), fall back to the first leg created this turn. Returns
 * null only when no leg was created this turn, in which case the caller should
 * surface the original "Leg not found" error.
 *
 * NON-consuming by design: multiple stops can legitimately share one new leg,
 * so this never removes a leg from the list.
 */
export function pickNearestNewLeg(
  point: { lat?: number | null; lng?: number | null } | null,
  newLegs: readonly NewLegRecord[]
): string | null {
  if (newLegs.length === 0) return null;

  if (point?.lat != null && point?.lng != null) {
    let best: { id: string; deviationKm: number } | null = null;
    for (const leg of newLegs) {
      if (
        leg.startLat == null ||
        leg.startLng == null ||
        leg.endLat == null ||
        leg.endLng == null
      ) {
        continue;
      }
      const deviationKm = distanceToSegmentKm(
        point.lat,
        point.lng,
        leg.startLat,
        leg.startLng,
        leg.endLat,
        leg.endLng
      );
      if (best == null || deviationKm < best.deviationKm) {
        best = { id: leg.id, deviationKm };
      }
    }
    if (best != null) return best.id;
  }

  // No usable coordinate on the item or on any new leg → first leg this turn.
  return newLegs[0].id;
}

/**
 * A leg whose start and end are the same place (within this many km): a rest
 * or base day. The replan route records same-turn legs without their
 * `leg_type`, but a stay is recognisable from its coordinates alone — Penny's
 * add_leg for a base day repeats the location as both ends.
 */
export const STAY_IN_PLACE_KM = 1;

/**
 * How close a stop must be to a same-turn rest day's location to belong to it:
 * the town being stayed in. 5 km covers a city's sights from the point Penny
 * gives for the town (Strasbourg Cathedral is 0.94 km from it) while leaving a
 * stop further out on the next day's drive where Penny put it.
 */
export const REST_DAY_STOP_RADIUS_KM = 5;

/** How close a leg's start or end must be to the rest location to be "next to" it. */
export const ADJACENT_TO_REST_KM = 1;

/** A leg's two ends, as `getTripFull` reads them. */
export type LegEnds = {
  id: string;
  startLat: number | null;
  startLng: number | null;
  endLat: number | null;
  endLng: number | null;
};

function isStayInPlace(leg: LegEnds): leg is LegEnds & {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
} {
  return (
    leg.startLat != null &&
    leg.startLng != null &&
    leg.endLat != null &&
    leg.endLng != null &&
    haversineKm(leg.startLat, leg.startLng, leg.endLat, leg.endLng) <= STAY_IN_PLACE_KM
  );
}

/**
 * The same-turn rest days a stop at `point` could belong to, nearest first.
 * Cheap and pure: the caller reads the proposed leg from the database only
 * when this is non-empty.
 */
export function nearbySameTurnRestLegs(
  point: { lat?: number | null; lng?: number | null } | null,
  newLegs: readonly NewLegRecord[]
): { id: string; distanceKm: number }[] {
  if (point?.lat == null || point?.lng == null) return [];
  const { lat, lng } = point as { lat: number; lng: number };
  return newLegs
    .filter(isStayInPlace)
    .map((leg) => ({ id: leg.id, distanceKm: haversineKm(lat, lng, leg.startLat, leg.startLng) }))
    .filter((c) => c.distanceKm <= REST_DAY_STOP_RADIUS_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/**
 * Re-home an `add_stop` that names a REAL leg onto a rest day created this
 * same turn, when that is plainly where it belongs. Returns the rest leg's id,
 * or null to keep the leg Penny named.
 *
 * Why: a rest day Penny adds in a turn has no real id until dispatch, so when
 * she puts a stop on it in the SAME turn she names the only real leg she knows
 * in that town — the drive leg next to it. On 2026-10-07 "a rest day in
 * Strasbourg with the cathedral as a stop" saved the cathedral on Strasbourg →
 * Stuttgart, not on the new base day. `pickNearestNewLeg` never fired: the id
 * she gave was real, not invented.
 *
 * All of these must hold, or nothing changes:
 *   - a leg created this turn is a stay-in-place leg (start ≈ end);
 *   - the stop is within REST_DAY_STOP_RADIUS_KM of that stay's location;
 *   - the named leg starts or ends at that location (it is the day before or
 *     after the stay), and is not itself a stay there — an existing rest day
 *     in the same town is a legitimate target and is left alone.
 */
export function pickSameTurnRestLeg(
  point: { lat?: number | null; lng?: number | null } | null,
  proposedLeg: LegEnds,
  newLegs: readonly NewLegRecord[]
): string | null {
  if (newLegs.some((leg) => leg.id === proposedLeg.id)) return null;
  const [nearest] = nearbySameTurnRestLegs(point, newLegs);
  if (!nearest) return null;
  const rest = newLegs.find((leg) => leg.id === nearest.id);
  if (!rest || !isStayInPlace(rest)) return null;

  const near = (lat: number | null, lng: number | null) =>
    lat != null && lng != null && haversineKm(lat, lng, rest.startLat, rest.startLng) <= ADJACENT_TO_REST_KM;

  if (isStayInPlace(proposedLeg) && near(proposedLeg.startLat, proposedLeg.startLng)) return null;
  const adjacent =
    near(proposedLeg.startLat, proposedLeg.startLng) || near(proposedLeg.endLat, proposedLeg.endLng);
  return adjacent ? rest.id : null;
}
