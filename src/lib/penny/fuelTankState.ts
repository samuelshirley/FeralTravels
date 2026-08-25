/**
 * fuelTankState.ts — pure tank-state math for the fuel planner.
 *
 * THE MODEL ("one continuous drive"): the whole trip is treated as a single
 * long drive. The ONLY thing that refills the tank is an actual fuel stop (or
 * the trip start). Rest days and overnight stops are NOT implicit refuels —
 * range burned flows straight through them.
 *
 * Why not assume a refuel at rest/overnight? An overland rest spot is often a
 * remote camp with no station. The old planner assumed "you topped up near
 * camp," which under-planned: a driver who burned 217 km before a 3-day rest
 * was treated as starting the next leg on a full tank, so a 450 km leg got
 * zero fuel stops and the driver ran dry partway. Erring toward "never run
 * dry" is the right bias for a self-sufficient overland trip; an unneeded fuel
 * suggestion is dismissable, an empty tank in the middle of nowhere is not.
 *
 * Pure functions only — no I/O, no DB, no 'server-only'. The DB shim that
 * gathers leg/stop rows and calls this lives in `src/server/fuel.ts`
 * (computeKmBurnedSinceLastRefuel); keeping the math here makes it
 * unit-testable. Mirrors the [[schedule]] / [[planSummary]] pattern.
 */

/** One preceding leg's contribution to tank state, in route order. */
export interface LegFuelHistory {
  /**
   * Leg driving distance in km. Null/0 for rest legs (they carry no distance,
   * so they pass straight through without affecting the burn).
   */
  distanceKm: number | null;
  /**
   * Distance-from-leg-start (km) of the latest non-dismissed fuel stop on this
   * leg, or null if the leg has no actual fuel stop. Both user-`selected` and
   * planner-`option` fuel stops count so the multi-leg plan stays
   * self-consistent; only `dismissed` stops are excluded by the caller.
   */
  latestFuelDistanceKm: number | null;
  /**
   * Declared tank state anchored at this leg's START: the equivalent km of
   * range ALREADY BURNED when the leg begins (range_km − the driver's
   * declared remaining km, clamped ≥ 0 by the caller). Set on at most one leg —
   * the `trips.declared_range_leg_id` anchor. The declaration is a baseline,
   * not a refuel: a real fuel stop on this same leg is LATER than its start
   * and therefore wins (the walk-back hits the stop first). See the
   * `declare_fuel_state` Penny tool.
   */
  declaredBurnedKmAtStart?: number | null;
}

/**
 * How many km of range are already burned when the current leg begins.
 *
 * @param precedingReversed Preceding legs in REVERSE route order — the leg
 *   nearest the current one first, walking back toward the trip start. The
 *   caller may short-circuit and stop gathering once it includes the first leg
 *   that has a fuel stop (the refuel anchor); everything before that anchor is
 *   irrelevant to the burn.
 *
 * Walk back accumulating each leg's distance. The first leg that contains an
 * actual fuel stop is the last refuel: add only the distance driven AFTER that
 * stop (legDistance − fuelStopDistanceFromStart) and stop. A leg carrying a
 * declared tank state at its start (and no fuel stop) is likewise terminal:
 * the declaration IS the tank baseline there, so add the leg's full distance
 * plus the declared burned km and stop — nothing before the declaration
 * matters. If we reach the trip start without finding either, the whole
 * accumulated distance has been burned on a single tank.
 */
export function kmBurnedSinceLastRefuel(
  precedingReversed: LegFuelHistory[]
): number {
  let kmBurned = 0;
  for (const leg of precedingReversed) {
    const legDist = leg.distanceKm ?? 0;
    if (leg.latestFuelDistanceKm != null) {
      // Refuel anchor: only the post-refuel portion of this leg is burned.
      // Note this deliberately beats a declaration on the same leg — the fuel
      // stop is later in the leg than its start, so the tank was reset after
      // the declared baseline applied.
      kmBurned += Math.max(0, legDist - leg.latestFuelDistanceKm);
      return kmBurned;
    }
    if (leg.declaredBurnedKmAtStart != null) {
      // Declared-tank anchor: the driver told us the tank state at this leg's
      // start. Burn = everything since (this leg + later legs already
      // accumulated) on top of the declared baseline.
      return kmBurned + legDist + Math.max(0, leg.declaredBurnedKmAtStart);
    }
    // No refuel here (driving leg with no fuel stop, or a rest day → 0 km).
    // Carry the full distance forward and keep walking back.
    kmBurned += legDist;
  }
  return kmBurned;
}
