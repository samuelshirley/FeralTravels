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
 * Pure + dependency-light: no I/O, no LLM. The server layer (`server/fuel.ts`)
 * feeds it candidates already projected onto the route and filtered for
 * eligibility (`stationFilter.ts`); this module only decides *which* and *where*.
 *
 * See docs/design/finn-fuel-agent.md → "The selection algorithm".
 */

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
}

export interface PlacedStop {
  candidate: PlacementCandidate;
  /** Burn since last refuel at the moment of arrival at this stop, km. */
  arrivalBurnKm: number;
  /**
   * Mandatory when geography forces a top-up the driver wouldn't otherwise make
   * (a long dry stretch ahead). A forced stop *with* a reason reads as smart;
   * without one it reads as broken. See CLAUDE.md Finn contract.
   */
  reason?: string;
}

export interface PlacementResult {
  stops: PlacedStop[];
  /**
   * True when the leg cannot be completed without running past R — a stranding
   * risk. The caller raises the honest `no_stations_found` / gap warning.
   */
  gap: boolean;
  gapDetail?: string;
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
 * Plan the fuel stops for one leg. Greedy: from each refuel anchor, take the
 * farthest stop within range, refuel, and repeat until the leg end is
 * reachable.
 */
export function planLegFuelStops(input: PlacementInput): PlacementResult {
  const { legLengthKm, rangeKm: R } = input;

  const sorted = input.candidates
    .filter((c) => c.alongKm > EPS && c.alongKm <= legLengthKm + EPS)
    .sort((a, b) => a.alongKm - b.alongKm);

  const stops: PlacedStop[] = [];
  let anchorKm = 0; // along-leg position of the last refuel (0 = leg start)
  let burnAtAnchor = Math.max(0, input.kmBurnedAtStart);

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const reach = R - burnAtAnchor; // furthest drivable from the anchor
    const distToEnd = legLengthKm - anchorKm;

    // End reachable on the current tank → done.
    if (distToEnd <= reach + EPS) {
      return { stops, gap: false };
    }

    const ahead = sorted.filter((c) => c.alongKm > anchorKm + EPS);
    const safe = ahead.filter((c) => c.alongKm - anchorKm <= reach + EPS);

    if (safe.length === 0) {
      const next = ahead[0];
      const gapDetail = next
        ? `Next fuel is ${Math.round(next.alongKm - anchorKm)} km ahead — beyond safe range (${Math.round(reach)} km). Carry extra fuel or top up earlier.`
        : `No fuel stations ahead on this leg within safe range. Carry extra fuel.`;
      return { stops, gap: true, gapDetail };
    }

    const pick = choose(safe);

    // Forced-stop reason: topping up because the next fuel (or, failing that, a
    // long run) is far enough that skipping this station risks running dry.
    const nextAfter = sorted.find((c) => c.alongKm > pick.alongKm + EPS);
    const gapAfterKm = (nextAfter ? nextAfter.alongKm : legLengthKm) - pick.alongKm;
    let reason: string | undefined;
    if (nextAfter && gapAfterKm > R) {
      reason = `next fuel is ${Math.round(gapAfterKm)} km away`;
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
  return { stops, gap: false };
}
