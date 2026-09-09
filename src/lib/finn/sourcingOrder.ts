/**
 * sourcingOrder.ts — which earlier days must be sourced before day N can be
 * planned honestly.
 *
 * THE PROBLEM THIS SOLVES. Fuel stops are sourced lazily, when the driver opens
 * a day. The tank walk in `fuelTankState.ts` then walks BACKWARDS from the leg
 * being planned looking for the last refuel, and a day that was never opened has
 * no fuel stop on it — which is indistinguishable from a day that genuinely
 * needed none. Both read as "drove that far, never refuelled", so the burn
 * accumulates across every unopened day.
 *
 * On trip `ab824cde` (2026-09-09) the driver opened day 11 first. Days 2, 4, 5,
 * 7 and 9 had never been opened, so the walk reached day 0's fuel stop and
 * reported 2,396 km burned against a 500 km range. Finn was asked to plan a leg
 * on a tank 1,896 km overdrawn and told the driver a station 44 km away was
 * "beyond safe range".
 *
 * THE FIX. Before planning day N, source every unsourced DRIVE day between the
 * last real refuel and N, oldest first. Finn runs on OSRM + OSM Overpass, both
 * free, so this costs no money — CLAUDE.md's "never a trip-wide fan-out" rule
 * was about paid Google Places calls and is not a rule about dependency order.
 * This is bounded by the last refuel, not by the trip: it is a cascade, not a
 * fan-out.
 *
 * Pure — no I/O, no DB. The shim that loads rows and runs the cascade lives in
 * `src/server/fuel.ts`. Same split as [[fuelTankState]] / [[plan]].
 */

/** What the cascade needs to know about one leg preceding the target. */
export interface LegSourcingState {
  id: string;
  /** Route order. The caller passes preceding legs ASCENDING. */
  sortOrder: number;
  /** Only drive legs burn fuel; rest days pass straight through. */
  legType: string;
  fuelStatus: string;
  /** True when the leg carries a real (non-dismissed) fuel stop — a refuel. */
  hasFuelStop: boolean;
}

export interface SourcingPlan {
  /**
   * Leg ids to source, OLDEST FIRST. Order is load-bearing: each leg's own tank
   * walk reads the results of the ones before it, so sourcing newest-first
   * would plan every one of them on the same wrong burn we are fixing.
   */
  toSource: string[];
  /**
   * Legs another in-flight request holds (`computing` / `pending`). Reported,
   * never sourced — planning one twice concurrently would have both writes race
   * on the same leg's stops. The caller decides whether to wait or to give up
   * with a retryable `failed`.
   */
  blockedBy: string[];
}

/** Statuses meaning "this leg has never been searched, or the search broke". */
const UNSOURCED = new Set(['none', 'failed']);
/** Statuses meaning "another request is working on this leg right now". */
const IN_FLIGHT = new Set(['computing', 'pending']);

/**
 * Decide which preceding legs must be sourced before the target leg is planned.
 *
 * @param precedingInOrder Every leg before the target, ASCENDING by sortOrder.
 * @param declaredAnchorLegId The leg carrying the driver's declared tank state
 *   (`trips.declared_range_leg_id`), if any. A declaration re-baselines the
 *   tank, so nothing before it can affect the burn and sourcing it would be
 *   wasted work.
 *
 * A leg that is already `ready` or `no_stations_found` is left alone even when
 * it has no fuel stop: it HAS been searched, and "no stop needed" is a real
 * answer the walk-back is entitled to believe.
 */
export function legsNeedingSourcingBefore(
  precedingInOrder: LegSourcingState[],
  declaredAnchorLegId?: string | null
): SourcingPlan {
  // Everything at or before the last refuel is irrelevant — that is where the
  // tank walk stops. Same for a declared tank state, which is a baseline the
  // walk treats as terminal.
  let anchorIdx = -1;
  for (let i = 0; i < precedingInOrder.length; i++) {
    const leg = precedingInOrder[i];
    if (leg.hasFuelStop || (declaredAnchorLegId != null && leg.id === declaredAnchorLegId)) {
      anchorIdx = i;
    }
  }

  const toSource: string[] = [];
  const blockedBy: string[] = [];
  for (const leg of precedingInOrder.slice(anchorIdx + 1)) {
    if (leg.legType !== 'drive') continue; // rest days burn nothing
    if (IN_FLIGHT.has(leg.fuelStatus)) {
      blockedBy.push(leg.id);
      continue;
    }
    if (UNSOURCED.has(leg.fuelStatus)) toSource.push(leg.id);
  }
  return { toSource, blockedBy };
}
