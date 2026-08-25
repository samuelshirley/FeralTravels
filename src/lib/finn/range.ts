/**
 * Finn range math — the single fuel-range tank model.
 *
 * One number, captured by Penny and already on the vehicle row, reaches Finn
 * untouched:
 *   - R = `range_km` — the driver's fuel range between fills.
 *
 * B = km burned since the last actual refuel (from `fuelTankState.ts`).
 *
 * Hard rule: never recommend a stop whose arrival distance exceeds R. Within
 * that, stop as late as possible (fewer stops). See
 * `docs/design/finn-fuel-agent.md`.
 *
 * Pure functions only — no I/O. Price scoring is layered on top later; this is
 * the safety + placement skeleton.
 */

export interface TankState {
  /** R — fuel range, km. */
  rangeKm: number;
  /** B — km burned since the last refuel. */
  kmBurnedSinceLastRefuel: number;
}

/** Furthest we can still drive before crossing the range R. */
export function reachableMaxKm(t: TankState): number {
  return Math.max(0, t.rangeKm - t.kmBurnedSinceLastRefuel);
}

/** A stop `distanceAheadKm` further on is safe iff it's within reach of R. */
export function isSafe(distanceAheadKm: number, t: TankState): boolean {
  return distanceAheadKm >= 0 && distanceAheadKm <= reachableMaxKm(t);
}

/** A reachable fuel candidate, measured as distance ahead of the current fuel position. */
export interface FuelCandidate {
  id: string;
  /** Distance from the current fuel position to this candidate, along the route (km). */
  distanceAheadKm: number;
}

export interface NextStopPlan<C extends FuelCandidate = FuelCandidate> {
  /** Chosen next stop, or null when none is safely reachable (a gap). */
  pick: C | null;
  /**
   * True when NO candidate is reachable within R — a stranding risk that must
   * raise the deterministic gap alarm (fill before the gap / carry fuel).
   */
  gap: boolean;
  reachableMaxKm: number;
}

/**
 * Pick the next fuel stop from candidates ahead.
 *
 * Strategy: among candidates reachable within R, take the **farthest** one —
 * maximizing progress so the driver makes the fewest stops without ever cutting
 * past the range. If no candidate is reachable at all, flag a gap (the alarm is
 * the caller's to raise).
 *
 * Note this is placement only; once prices exist, scoring re-ranks the safe pool
 * by price/detour rather than pure distance.
 */
export function planNextStop<C extends FuelCandidate>(
  candidates: C[],
  t: TankState
): NextStopPlan<C> {
  const reach = reachableMaxKm(t);

  const safe = candidates.filter((c) => c.distanceAheadKm >= 0 && c.distanceAheadKm <= reach);
  if (safe.length === 0) {
    return { pick: null, gap: true, reachableMaxKm: reach };
  }

  const pick = safe.reduce((a, b) => (b.distanceAheadKm > a.distanceAheadKm ? b : a));

  return {
    pick,
    gap: false,
    reachableMaxKm: reach,
  };
}
