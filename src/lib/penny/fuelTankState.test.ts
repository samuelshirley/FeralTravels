import { describe, it, expect } from 'vitest';
import {
  kmBurnedSinceLastRefuel,
  type LegFuelHistory,
} from './fuelTankState';

/**
 * `precedingReversed` is in REVERSE route order: index 0 is the leg nearest the
 * leg being planned, walking back toward the trip start.
 */
describe('kmBurnedSinceLastRefuel (continuous-drive model)', () => {
  it('returns 0 for the first leg of a trip (no preceding legs)', () => {
    expect(kmBurnedSinceLastRefuel([])).toBe(0);
  });

  it('carries the full distance of an unfueled driving leg forward', () => {
    const history: LegFuelHistory[] = [
      { distanceKm: 450, latestFuelDistanceKm: null },
    ];
    expect(kmBurnedSinceLastRefuel(history)).toBe(450);
  });

  it('anchors on a fuel stop and only counts distance driven after it', () => {
    // 627 km leg, last fuel at the 410 mark → 217 km burned since refuel.
    const history: LegFuelHistory[] = [
      { distanceKm: 627, latestFuelDistanceKm: 410 },
    ];
    expect(kmBurnedSinceLastRefuel(history)).toBe(217);
  });

  it('REGRESSION: a rest day between drives does NOT reset the tank', () => {
    // The reported bug: prior driving day = 627 km with fuel at 410 (→217 km
    // burned), then a rest day, then the leg being planned. The rest day must
    // pass straight through (0 km, no reset), so the planner sees 217 km of
    // range already gone — not a full tank.
    const history: LegFuelHistory[] = [
      { distanceKm: null, latestFuelDistanceKm: null }, // rest day (nearest)
      { distanceKm: 627, latestFuelDistanceKm: 410 }, // last drive, fuel @410
    ];
    expect(kmBurnedSinceLastRefuel(history)).toBe(217);
  });

  it('carries burn across MULTIPLE rest days', () => {
    const history: LegFuelHistory[] = [
      { distanceKm: null, latestFuelDistanceKm: null }, // rest 3
      { distanceKm: null, latestFuelDistanceKm: null }, // rest 2
      { distanceKm: null, latestFuelDistanceKm: null }, // rest 1
      { distanceKm: 627, latestFuelDistanceKm: 410 },
    ];
    expect(kmBurnedSinceLastRefuel(history)).toBe(217);
  });

  it('does NOT treat an overnight (a leg with no fuel stop) as a refuel', () => {
    // Two consecutive driving days with no fuel stops on either. Under the old
    // model the overnight at the end of the first leg reset the tank; now the
    // full distance of both legs accumulates.
    const history: LegFuelHistory[] = [
      { distanceKm: 300, latestFuelDistanceKm: null }, // day 2, no fuel
      { distanceKm: 250, latestFuelDistanceKm: null }, // day 1, no fuel
    ];
    expect(kmBurnedSinceLastRefuel(history)).toBe(550);
  });

  it('stops accumulating at the first (nearest) fuel anchor', () => {
    // Once a fuel stop is found, earlier legs are irrelevant. Here the nearest
    // leg has a fuel stop near its end, so almost nothing is burned regardless
    // of what came before.
    const history: LegFuelHistory[] = [
      { distanceKm: 500, latestFuelDistanceKm: 480 }, // burned 20 since refuel
      { distanceKm: 600, latestFuelDistanceKm: 100 }, // should be ignored
    ];
    expect(kmBurnedSinceLastRefuel(history)).toBe(20);
  });

  it('sums unfueled legs then adds the post-refuel remainder of the anchor leg', () => {
    // Nearest leg: unfueled 200 km. Next: unfueled 150 km. Anchor leg: 400 km
    // with fuel at 300 → 100 km after refuel. Total = 200 + 150 + 100 = 450.
    const history: LegFuelHistory[] = [
      { distanceKm: 200, latestFuelDistanceKm: null },
      { distanceKm: 150, latestFuelDistanceKm: null },
      { distanceKm: 400, latestFuelDistanceKm: 300 },
    ];
    expect(kmBurnedSinceLastRefuel(history)).toBe(450);
  });

  it('treats a fuel stop at the very end of a leg as a clean fill (0 carried)', () => {
    const history: LegFuelHistory[] = [
      { distanceKm: 500, latestFuelDistanceKm: 500 },
    ];
    expect(kmBurnedSinceLastRefuel(history)).toBe(0);
  });

  it('clamps a fuel stop recorded beyond the leg distance to 0 (never negative)', () => {
    // Defensive: stored distance_from_start shouldn't exceed leg distance, but
    // if it does we must not report negative burn.
    const history: LegFuelHistory[] = [
      { distanceKm: 400, latestFuelDistanceKm: 450 },
    ];
    expect(kmBurnedSinceLastRefuel(history)).toBe(0);
  });

  it('a fuel stop on a rest leg correctly anchors the tank (user topped up in town)', () => {
    // Rest leg has 0 distance but a manually-added fuel stop at 0 → clean fill,
    // nothing carried from before it.
    const history: LegFuelHistory[] = [
      { distanceKm: 0, latestFuelDistanceKm: 0 }, // rest day, user fueled
      { distanceKm: 627, latestFuelDistanceKm: 410 }, // ignored — anchor above
    ];
    expect(kmBurnedSinceLastRefuel(history)).toBe(0);
  });
});

describe('declared tank state (the declare_fuel_state tool)', () => {
  it('a declaration on a preceding leg is terminal: burn = declared baseline + everything since', () => {
    // Trip d0b5741b shape: driver declares 150 km remaining (500 comfortable →
    // 350 burned) at the start of yesterday's 296 km leg... then drives it.
    // Planning today's leg: 350 + 296 = 646 burned.
    const history: LegFuelHistory[] = [
      { distanceKm: 296, latestFuelDistanceKm: null, declaredBurnedKmAtStart: 350 },
    ];
    expect(kmBurnedSinceLastRefuel(history)).toBe(646);
  });

  it('legs before the declared anchor are ignored (the declaration IS the baseline)', () => {
    const history: LegFuelHistory[] = [
      { distanceKm: 100, latestFuelDistanceKm: null },
      { distanceKm: 200, latestFuelDistanceKm: null, declaredBurnedKmAtStart: 50 },
      { distanceKm: 900, latestFuelDistanceKm: null }, // must not count
    ];
    // 100 + 200 + 50 = 350; the 900 km leg predates the declaration.
    expect(kmBurnedSinceLastRefuel(history)).toBe(350);
  });

  it('a real fuel stop on the SAME leg beats the declaration (refuel is later than leg start)', () => {
    // Driver declared low tank at leg start, then Finn placed a stop at 150 on
    // that 200 km leg. Burn since refuel = 200 − 150 = 50; declaration is
    // superseded.
    const history: LegFuelHistory[] = [
      { distanceKm: 200, latestFuelDistanceKm: 150, declaredBurnedKmAtStart: 350 },
    ];
    expect(kmBurnedSinceLastRefuel(history)).toBe(50);
  });

  it('a fuel stop on a leg NEARER than the anchor supersedes the declaration', () => {
    const history: LegFuelHistory[] = [
      { distanceKm: 300, latestFuelDistanceKm: 250 }, // refuel after declaring
      { distanceKm: 296, latestFuelDistanceKm: null, declaredBurnedKmAtStart: 350 },
    ];
    expect(kmBurnedSinceLastRefuel(history)).toBe(50);
  });

  it('a full-tank declaration (declared ≥ comfortable → 0 burned) clamps cleanly', () => {
    const history: LegFuelHistory[] = [
      { distanceKm: 120, latestFuelDistanceKm: null, declaredBurnedKmAtStart: 0 },
    ];
    expect(kmBurnedSinceLastRefuel(history)).toBe(120);
  });

  it('a negative declared burn (declared > comfortable, defensive) clamps to 0', () => {
    const history: LegFuelHistory[] = [
      { distanceKm: 120, latestFuelDistanceKm: null, declaredBurnedKmAtStart: -40 },
    ];
    expect(kmBurnedSinceLastRefuel(history)).toBe(120);
  });
});
