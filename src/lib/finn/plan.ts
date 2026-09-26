/**
 * Finn's greedy multi-stop placement — the deterministic core that turns a list
 * of reachable stations into the actual fuel stops for one leg.
 *
 * Model (continuous drive, from `fuelTankState.ts`): the tank is full only at
 * trip start and after an *actual* fuel stop. `B` (km burned since last refuel)
 * is carried into the leg. From each refuel anchor Finn may drive at most
 * `R − B` (the vehicle's fuel range, never crossed). It walks the leg placing
 * the fewest safe stops.
 *
 * A leg's end is not a destination to arrive at empty: tomorrow's drive has to
 * reach ITS first station on what is left. `arrivalReserveKm` carries that
 * distance in, and the walk treats the leg as ending that much further on.
 *
 * Pure + dependency-light: no I/O, no LLM. The server layer (`server/fuel.ts`)
 * feeds it candidates already projected onto the route and filtered for
 * eligibility (`stationFilter.ts`); this module only decides *which* and *where*.
 *
 * See docs/design/finn-fuel-agent.md → "The selection algorithm".
 */

import type { ForcedStopReason } from '@/types/trip';

export interface PlacementCandidate {
  /** Stable id (Google place id). */
  id: string;
  /** Distance from leg start along the route, km. */
  alongKm: number;
  /** Cheap detour proxy (km off the route), used only as a tiebreak for now. */
  detourKm?: number;
}

export interface PlacementInput {
  /** Total leg length along the route, km. */
  legLengthKm: number;
  /** R — the vehicle's fuel range, km. */
  rangeKm: number;
  /** B — km already burned since the last refuel when the leg starts. */
  kmBurnedAtStart: number;
  /** Eligible, route-projected candidates (any order). */
  candidates: PlacementCandidate[];
  /**
   * Fuel the tank must still hold when this leg ends, km: how far the NEXT
   * drive day runs before its first station ([[fuelNeededAtLegStartKm]]).
   * 0 / absent when there is no next drive day.
   *
   * Without it the greedy walk stopped the moment the leg END was in reach, so
   * a day could finish on fumes. Spain trip `da203241` (2026-09-24): Monzón →
   * Cabrales arrived with 20 km left and the next day's first station was 27 km
   * in ("beyond safe range (20 km)"); Madrid → Isla Mayor topped up at km 3,
   * drove 549 of 550 km, and handed the next day an "impossible tank state".
   *
   * Best effort: if no station on this leg can make the reserve, the leg is
   * still planned (it can be finished) and the NEXT day raises its own honest
   * warning — the shortfall is that day's geography, not this one's.
   */
  arrivalReserveKm?: number;
}

export interface PlacedStop {
  candidate: PlacementCandidate;
  /** Burn since last refuel at the moment of arrival at this stop, km. */
  arrivalBurnKm: number;
  /**
   * Mandatory when geography forces a top-up the driver wouldn't otherwise make
   * (a long dry stretch ahead). A forced stop *with* a reason reads as smart;
   * without one it reads as broken. See CLAUDE.md Finn contract. Structured, so
   * the client can word it in the user's units.
   */
  reason?: ForcedStopReason;
}

/**
 * The three things that can come back from planning one leg. A discriminated
 * union rather than a `gap: boolean`, because the third case used to be
 * indistinguishable from the second and that is exactly how a driver was shown
 * "beyond safe range (-1896 km)".
 */
export type PlacementResult = PlacementPlanned | PlacementGap | PlacementTankStateInvalid;

/** Stops placed (possibly none — the leg fits on the fuel already in the tank). */
export interface PlacementPlanned {
  kind: 'planned';
  stops: PlacedStop[];
}

/**
 * The leg cannot be completed without running past R — a stranding risk, with
 * stations that exist but sit too far apart. The caller raises the honest
 * `no_stations_found` warning. Only reachable when the tank state is SANE, i.e.
 * there was some range left at the leg start; see [[PlacementTankStateInvalid]].
 */
export interface PlacementGap {
  kind: 'gap';
  stops: PlacedStop[];
  gapDetail: string;
}

/**
 * The tank was already empty (or worse) before the leg began — `R − B <= 0`.
 *
 * This is NOT geography and must never be reported as such. It means the burn
 * handed to the planner is not a fact about the world: in practice a preceding
 * day was never opened, so lazy day-open sourcing left it with no fuel stop,
 * and the walk-back in `fuelTankState.ts` counted its full distance as burned.
 * Trip `ab824cde` leg 11 reached B = 2,396 km against R = 500 and told the
 * driver "Next fuel is 44 km ahead — beyond safe range (-1896 km)" — a real
 * station 44 km away, described as unreachable, on a full tank. The other
 * way in was a day planned to arrive with 0 km to spare (Spain trip
 * `da203241`, "550 km burned against a 550 km range"), closed by
 * `arrivalReserveKm`.
 *
 * The server maps this to a RETRYABLE `failed`, never the 48h-cached
 * `no_stations_found`. After the sourcing cascade and the next-day look-ahead
 * in `server/fuel.ts` it should be unreachable; it is logged so we find out if
 * it is not.
 */
export interface PlacementTankStateInvalid {
  kind: 'tank_state_invalid';
  stops: [];
  /** B — what the walk-back claimed was already burned, km. */
  burnedKm: number;
  /** R — the vehicle's range, km. */
  rangeKm: number;
}

const EPS = 1e-6;
// Defensive cap; a real leg never needs this many stops.
const MAX_ITERATIONS = 64;

/**
 * Choose one stop from a non-empty pool of reachable candidates: the farthest
 * reachable one, which minimises the total number of stops on the leg.
 */
function choose(pool: PlacementCandidate[]): PlacementCandidate {
  return pool.reduce((best, c) => (c.alongKm > best.alongKm ? c : best));
}

/**
 * A station's along-route position, in the km the tank walk reads back.
 *
 * The walk (`fuelTankState.ts`) measures a leg by `legs.distance_km` and a stop
 * by its stored whole-km `distance_from_start_km`; projection measures along
 * the decoded polyline, which runs ~0.3% short of the Directions distance. When
 * the planner used one set of numbers and the walk read back the other, a day
 * that arrived with 0–1 km to spare came back 1–2 km over range the next day.
 * Planning on exactly what will be read back makes the two agree to the km.
 */
export function alongKmOnLeg(
  polylineAlongKm: number,
  polylineLengthKm: number,
  legLengthKm: number
): number {
  if (!(polylineLengthKm > 0)) return Math.round(polylineAlongKm);
  return Math.round((polylineAlongKm * legLengthKm) / polylineLengthKm);
}

/**
 * How much fuel a drive day needs in the tank when it starts, km: enough to
 * reach its first station, or its end if there is none before it. Capped at R —
 * a full tank is the most the day before can hand over.
 *
 * Measured with the same filter [[planLegFuelStops]] applies, so a station the
 * planner would not use does not count as "fuel ahead" here either.
 */
export function fuelNeededAtLegStartKm(
  legLengthKm: number,
  candidates: PlacementCandidate[],
  rangeKm: number
): number {
  let first = legLengthKm;
  for (const c of candidates) {
    if (c.alongKm > EPS && c.alongKm < first) first = c.alongKm;
  }
  return Math.max(0, Math.min(first, rangeKm));
}

/**
 * Plan the fuel stops for one leg. Greedy: from each refuel anchor, take the
 * farthest stop within range, refuel, and repeat until the leg end — plus the
 * next day's first stretch, `arrivalReserveKm` — is reachable.
 */
export function planLegFuelStops(input: PlacementInput): PlacementResult {
  const { legLengthKm, rangeKm: R } = input;
  const reserve = Math.max(0, input.arrivalReserveKm ?? 0);

  // STRUCTURAL GUARD. Below this line every branch may assume there is fuel in
  // the tank. `reach` is `R - burnAtAnchor`, and a negative reach makes every
  // candidate unreachable — including one 44 km away — so the loop falls into
  // the gap branch and describes an arithmetic failure as remote geography.
  // Returning a distinct outcome here is what makes that sentence impossible
  // to produce rather than merely unlikely.
  const burnedAtStart = Math.max(0, input.kmBurnedAtStart);
  if (R - burnedAtStart <= 0) {
    return { kind: 'tank_state_invalid', stops: [], burnedKm: burnedAtStart, rangeKm: R };
  }

  const sorted = input.candidates
    .filter((c) => c.alongKm > EPS && c.alongKm <= legLengthKm + EPS)
    .sort((a, b) => a.alongKm - b.alongKm);

  const stops: PlacedStop[] = [];
  let anchorKm = 0; // along-leg position of the last refuel (0 = leg start)
  let burnAtAnchor = burnedAtStart;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const reach = R - burnAtAnchor; // furthest drivable from the anchor
    const distToEnd = legLengthKm - anchorKm;

    // End reachable on the current tank, with the next day's first stretch
    // still in it → done.
    if (distToEnd + reserve <= reach + EPS) {
      return { kind: 'planned', stops };
    }
    const endReachable = distToEnd <= reach + EPS;

    const ahead = sorted.filter((c) => c.alongKm > anchorKm + EPS);
    const safe = ahead.filter((c) => c.alongKm - anchorKm <= reach + EPS);

    if (safe.length === 0) {
      // Only the reserve is out of reach, and nothing left on this leg can
      // help: finish the leg; the next day warns about its own dry start.
      if (endReachable) return { kind: 'planned', stops };
      const next = ahead[0];
      const gapDetail = next
        ? `Next fuel is ${Math.round(next.alongKm - anchorKm)} km ahead — beyond safe range (${Math.round(reach)} km). Carry extra fuel or top up earlier.`
        : `No fuel stations ahead on this leg within safe range. Carry extra fuel.`;
      return { kind: 'gap', stops, gapDetail };
    }

    const pick = choose(safe);

    // Forced-stop reason: topping up because the next fuel (or, failing that, a
    // long run) is far enough that skipping this station risks running dry.
    const nextAfter = sorted.find((c) => c.alongKm > pick.alongKm + EPS);
    const gapAfterKm = (nextAfter ? nextAfter.alongKm : legLengthKm) - pick.alongKm;
    let reason: ForcedStopReason | undefined;
    if (nextAfter && gapAfterKm > R) {
      reason = { kind: 'next_fuel_far', gap_km: Math.round(gapAfterKm) };
    } else if (endReachable) {
      // Today alone would not need this stop; tomorrow's first fuel does. The
      // leg end was in reach, so every station left on the leg was too and
      // this is the last one — the next fuel is on the next day's drive.
      reason = { kind: 'next_day_fuel_far', gap_km: Math.round(gapAfterKm + reserve) };
    }

    stops.push({
      candidate: pick,
      arrivalBurnKm: burnAtAnchor + (pick.alongKm - anchorKm),
      reason,
    });
    anchorKm = pick.alongKm;
    burnAtAnchor = 0; // refueled
  }

  // Should never get here for a real leg; return what we have rather than loop.
  return { kind: 'planned', stops };
}
