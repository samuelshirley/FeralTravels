import 'server-only';
import { distanceToSegmentKm } from '@/lib/penny/geo';

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
