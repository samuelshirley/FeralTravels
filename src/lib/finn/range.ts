/**
 * Finn range math — the comfortable (C) / hard-max (H) tank model.
 *
 * Two numbers, both captured by Penny and already on the vehicle row
 * (migrations 0007/0011), reach Finn untouched:
 *   - C = `comfortable_range_km` — the everyday target between fills.
 *   - H = `hard_max_range_km`    — the absolute dry-stretch ceiling (≥ C).
 *
 * B = km burned since the last actual refuel (from `fuelTankState.ts`).
 *
 * Hard rule: never recommend a stop whose arrival distance exceeds H. Soft
 * preference: stop within C, and as late as possible within it (fewer stops).
 * If nothing sits within C, Finn extends into the C→H "stretch zone" before it
 * ever gives up — but never past H. See `docs/design/finn-fuel-agent.md`.
 *
 * Pure functions only — no I/O. Price scoring is layered on top later; this is
 * the safety + placement skeleton.
 */

export interface TankState {
  /** C — comfortable range, km. */
  comfortableRangeKm: number;
  /** H — hard-max range, km (≥ C). */
  hardMaxRangeKm: number;
  /** B — km burned since the last refuel. */
  kmBurnedSinceLastRefuel: number;
}

/** Furthest we can still drive before crossing the absolute ceiling H. */
export function reachableMaxKm(t: TankState): number {
  return Math.max(0, t.hardMaxRangeKm - t.kmBurnedSinceLastRefuel);
}

/** Furthest we'd *comfortably* drive before the target C. */
export function comfortMaxKm(t: TankState): number {
  return Math.max(0, t.comfortableRangeKm - t.kmBurnedSinceLastRefuel);
}

/** A stop `distanceAheadKm` further on is safe iff it's within reach of H. */
export function isSafe(distanceAheadKm: number, t: TankState): boolean {
  return distanceAheadKm >= 0 && distanceAheadKm <= reachableMaxKm(t);
}

/** ...and within comfort iff it's also within C. */
export function isInComfort(distanceAheadKm: number, t: TankState): boolean {
  return distanceAheadKm >= 0 && distanceAheadKm <= comfortMaxKm(t);
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
   * True when NO candidate is reachable within H — a stranding risk that must
   * raise the deterministic gap alarm (fill before the gap / carry fuel).
   */
  gap: boolean;
  /** Whether `pick` sits within comfort (C) vs the C→H stretch zone. */
  inComfort: boolean;
  reachableMaxKm: number;
  comfortMaxKm: number;
}

/**
 * Pick the next fuel stop from candidates ahead.
 *
 * Strategy: among candidates reachable within H, prefer those within C; from the
 * preferred pool, take the **farthest** one — maximizing progress so the driver
 * makes the fewest stops without ever cutting past the ceiling. If no candidate
 * is reachable at all, flag a gap (the alarm is the caller's to raise).
 *
 * Note this is placement only; once prices exist, scoring re-ranks the safe pool
 * by price/detour rather than pure distance.
 */
export function planNextStop<C extends FuelCandidate>(
  candidates: C[],
  t: TankState
): NextStopPlan<C> {
  const reach = reachableMaxKm(t);
  const comf = comfortMaxKm(t);

  const safe = candidates.filter((c) => c.distanceAheadKm >= 0 && c.distanceAheadKm <= reach);
  if (safe.length === 0) {
    return { pick: null, gap: true, inComfort: false, reachableMaxKm: reach, comfortMaxKm: comf };
  }

  const comfortable = safe.filter((c) => c.distanceAheadKm <= comf);
  const pool = comfortable.length > 0 ? comfortable : safe;
  const pick = pool.reduce((a, b) => (b.distanceAheadKm > a.distanceAheadKm ? b : a));

  return {
    pick,
    gap: false,
    inComfort: comfortable.length > 0,
    reachableMaxKm: reach,
    comfortMaxKm: comf,
  };
}
