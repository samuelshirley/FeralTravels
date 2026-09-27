import 'server-only';
import { assertLegOwnedByUser, ForbiddenError, NotFoundError } from '@/server/auth/guards';
import { addStop } from '@/server/repos/stops';
import { pickNearestNewLeg, type NewLegRecord } from '@/lib/penny/newLegFallback';
import type { AddStopInput } from '@/lib/penny/tools/addStop';

/**
 * Penny's `add_stop` write, moved verbatim out of `api/trip/replan/route.ts`
 * (whose private `dispatchAction` still owns every other action) so the one
 * test-only endpoint that proves a pasted Maps link lands as a stop —
 * `api/test/maps-link-stop` — runs the SAME code Penny's turn runs, rather
 * than a copy. A route file may export only its handlers, hence the module.
 */

/**
 * Per-request dispatch state for one POST /api/trip/replan.
 *
 * - `newLegIdsQueue`: consuming FIFO of `add_leg` ids, dequeued by the
 *   single-leg recovery fallback (`plan_fuel_stops`, `update_leg`,
 *   `plan_dump_station_stops`) when Penny guesses a leg_id before its row exists.
 * - `newLegs`: append-only record of every leg created this turn, WITH coords,
 *   used by the non-consuming `add_stop`/`add_route` fallback so a stop lands on
 *   the right same-turn leg (several stops may share one leg).
 */
export type ReplanDispatchCtx = { newLegIdsQueue: string[]; newLegs: NewLegRecord[] };

export function assertLegOnTrip(legTripId: string, tripId: string): void {
  if (legTripId !== tripId) throw new ForbiddenError('Leg is not part of this trip');
}

/**
 * Resolve the leg an `add_stop` / `add_route` action belongs to.
 *
 * Happy path: the proposed id is a real leg on this trip — return it.
 *
 * Fallback: the proposed id doesn't resolve because the item targets a leg
 * Penny CREATED earlier in this same turn. New legs are written only at
 * dispatch time, so Penny never saw their real UUID during the model loop and
 * invented one. We map that invented id onto a real new leg — geometry-first
 * (nearest new-leg corridor to the item's coordinate), else the first leg
 * created this turn. NON-consuming: several stops can share one new leg.
 *
 * Before this existed, `add_stop`/`add_route` on a same-turn leg threw
 * "Leg not found" and the action was silently dropped while the leg itself
 * saved — so Penny would promise a waypoint that never landed on the map. The
 * sibling actions (`update_leg`, `plan_dump_station_stops`) already had a
 * same-turn fallback; these two were the stragglers.
 */
export async function resolveLegForStopOrRoute(
  proposedLegId: string,
  point: { lat?: number | null; lng?: number | null } | null,
  tripId: string,
  userId: string,
  ctx: ReplanDispatchCtx
): Promise<string> {
  try {
    const ownerTripId = await assertLegOwnedByUser(proposedLegId, userId);
    assertLegOnTrip(ownerTripId, tripId);
    return proposedLegId;
  } catch (e) {
    const wrongTrip =
      e instanceof ForbiddenError && e.message === 'Leg is not part of this trip';
    if (!(e instanceof NotFoundError) && !wrongTrip) throw e;

    const fallbackLegId = pickNearestNewLeg(point, ctx.newLegs);
    if (fallbackLegId != null) return fallbackLegId;

    // No leg was created this turn — the id is genuinely bogus. Surface it.
    throw e;
  }
}

/**
 * Write a validated `add_stop` action: resolve its leg (with the same-turn
 * fallback above), then insert the stop. Returns the new stop's id.
 */
export async function applyAddStop(
  input: AddStopInput,
  tripId: string,
  userId: string,
  ctx: ReplanDispatchCtx
): Promise<string> {
  const { leg_id: proposedLegId, data } = input;
  const leg_id = await resolveLegForStopOrRoute(
    proposedLegId,
    { lat: data.lat, lng: data.lng },
    tripId,
    userId,
    ctx
  );
  const stop = await addStop({
    leg_id,
    stop_type: data.stop_type,
    name: data.name,
    status: data.status ?? 'option',
    lat: data.lat ?? null,
    lng: data.lng ?? null,
    distance_from_start_km: data.distance_from_start_km ?? null,
    notes: data.notes ?? null,
    // Penny only authors 'other' stops — fuel rows (with fuel_type/amount)
    // come from Finn's server-side planner, never this path.
    fuel_type: null,
    fuel_amount_l: null,
    source: data.source ?? 'penny',
    source_url: data.source_url ?? null,
  });
  return stop.id;
}
