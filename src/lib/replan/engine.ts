import 'server-only';
import { getDirections } from '@/lib/google/directions';
import type { TripWithLegs, LegWithDetails, LegConstraint } from '@/types/trip';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ReplanPosition {
  lat: number;
  lng: number;
}

export type ConstraintStatus = 'pass' | 'at_risk' | 'fail';

export interface ConstraintCheckResult {
  constraint: LegConstraint;
  leg: LegWithDetails;
  status: ConstraintStatus;
  detail: string;
  /** For arrive_by: computed "leave by" time (ISO string). */
  leave_by?: string;
}

export interface ReplanResult {
  feasible: boolean;
  updatedLegs: {
    legId: string;
    driveTimeMinutes: number;
    distanceKm: number;
  }[];
  constraintResults: ConstraintCheckResult[];
  currentLegIndex: number;
  deviationKm: number;
}

// ── GPS threshold bands ────────────────────────────────────────────────────

export type DeviationBand = 'on_track' | 'minor_drift' | 'off_route';

export function classifyDeviation(
  distanceKm: number,
  isRestDay: boolean,
): DeviationBand {
  if (isRestDay) {
    return distanceKm <= 50 ? 'on_track' : 'off_route';
  }
  if (distanceKm <= 20) return 'on_track';
  if (distanceKm <= 100) return 'minor_drift';
  return 'off_route';
}

// ── Haversine distance ─────────────────────────────────────────────────────

function haversineKm(a: ReplanPosition, b: ReplanPosition): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      sinLng * sinLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// ── Determine current leg ──────────────────────────────────────────────────

export function guessCurrentLeg(
  position: ReplanPosition,
  legs: LegWithDetails[],
): { legIndex: number; deviationKm: number } {
  let bestIndex = 0;
  let bestDist = Infinity;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.end_lat != null && leg.end_lng != null) {
      const dist = haversineKm(position, { lat: leg.end_lat, lng: leg.end_lng });
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
      }
    }
    if (leg.start_lat != null && leg.start_lng != null) {
      const dist = haversineKm(position, { lat: leg.start_lat, lng: leg.start_lng });
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
      }
    }
  }

  return { legIndex: bestIndex, deviationKm: bestDist };
}

// ── Deterministic replan (Level 1 — no AI tokens) ──────────────────────────

export async function deterministicReplan(
  position: ReplanPosition,
  trip: TripWithLegs,
): Promise<ReplanResult> {
  const allLegs = trip.legs;
  const { legIndex: currentLegIndex, deviationKm } = guessCurrentLeg(position, allLegs);

  // Recalculate drive times for remaining driving legs
  const updatedLegs: ReplanResult['updatedLegs'] = [];
  let origin: ReplanPosition = position;

  for (let i = currentLegIndex; i < allLegs.length; i++) {
    const leg = allLegs[i];
    if (leg.leg_type !== 'drive') continue;
    if (leg.end_lat == null || leg.end_lng == null) continue;

    const dest: ReplanPosition = { lat: leg.end_lat, lng: leg.end_lng };
    const dir = await getDirections(origin, dest);

    if (dir.ok) {
      updatedLegs.push({
        legId: leg.id,
        driveTimeMinutes: dir.drive_time_minutes,
        distanceKm: dir.distance_km,
      });
      origin = dest;
    } else {
      if (leg.drive_time_minutes != null && leg.distance_km != null) {
        updatedLegs.push({
          legId: leg.id,
          driveTimeMinutes: leg.drive_time_minutes,
          distanceKm: leg.distance_km,
        });
      }
      if (leg.end_lat != null && leg.end_lng != null) {
        origin = { lat: leg.end_lat, lng: leg.end_lng };
      }
    }
  }

  // Validate constraints
  const constraintResults: ConstraintCheckResult[] = [];
  const now = new Date();

  for (const leg of allLegs) {
    if (!leg.constraints || leg.constraints.length === 0) continue;
    for (const constraint of leg.constraints) {
      if (constraint.constraint_type === 'flexible') continue;
      if (!constraint.constraint_datetime) continue;

      const constraintTime = new Date(constraint.constraint_datetime);
      if (isNaN(constraintTime.getTime())) continue;

      const legIdx = allLegs.findIndex((l) => l.id === leg.id);
      let cumulativeDriveMinutes = 0;
      let cumulativeRestDays = 0;

      for (let i = currentLegIndex; i <= legIdx; i++) {
        const l = allLegs[i];
        if (l.leg_type === 'rest') {
          cumulativeRestDays++;
        } else {
          const updated = updatedLegs.find((u) => u.legId === l.id);
          cumulativeDriveMinutes += updated?.driveTimeMinutes ?? l.drive_time_minutes ?? 0;
        }
      }

      if (constraint.constraint_type === 'arrive_by') {
        const bufferMs = constraint.buffer_minutes * 60 * 1000;
        const driveMs = cumulativeDriveMinutes * 60 * 1000;
        const restMs = cumulativeRestDays * 24 * 60 * 60 * 1000;
        const estimatedArrival = new Date(now.getTime() + driveMs + restMs);
        const deadline = new Date(constraintTime.getTime() - bufferMs);

        const slackMs = deadline.getTime() - estimatedArrival.getTime();
        const slackHours = Math.round(slackMs / (60 * 60 * 1000));
        const leaveBy = new Date(constraintTime.getTime() - bufferMs - driveMs - restMs);

        let status: ConstraintStatus;
        let detail: string;
        if (slackMs < 0) {
          status = 'fail';
          detail = `${Math.abs(slackHours)}h past deadline (with ${constraint.buffer_minutes}min buffer).`;
        } else if (slackMs < 4 * 60 * 60 * 1000) {
          status = 'at_risk';
          detail = `Only ${slackHours}h of slack.`;
        } else {
          status = 'pass';
          detail = `${slackHours}h of slack.`;
        }

        constraintResults.push({ constraint, leg, status, detail, leave_by: leaveBy.toISOString() });
      } else if (constraint.constraint_type === 'depart_after') {
        constraintResults.push({
          constraint, leg, status: 'pass',
          detail: `Depart-after: do not leave before ${constraint.constraint_datetime}.`,
        });
      }
    }
  }

  return {
    feasible: constraintResults.every((r) => r.status !== 'fail'),
    updatedLegs,
    constraintResults,
    currentLegIndex,
    deviationKm,
  };
}
