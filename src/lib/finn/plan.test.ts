import { describe, it, expect } from 'vitest';
import { planLegFuelStops, type PlacementCandidate } from './plan';

const c = (id: string, alongKm: number): PlacementCandidate => ({
  id,
  alongKm,
});

describe('planLegFuelStops', () => {
  it('places no stop when the leg fits on the current tank', () => {
    const r = planLegFuelStops({
      legLengthKm: 300,
      rangeKm: 400,
      kmBurnedAtStart: 0,
      candidates: [c('a', 150)],
    });
    expect(r.stops).toHaveLength(0);
    expect(r.kind).toBe('planned');
  });

  it('places stops greedily across a long leg', () => {
    const r = planLegFuelStops({
      legLengthKm: 600,
      rangeKm: 250,
      kmBurnedAtStart: 0,
      candidates: [c('a', 180), c('b', 360), c('d', 540)],
    });
    expect(r.kind).toBe('planned');
    expect(r.stops.map((s) => s.candidate.id)).toEqual(['a', 'b']);
  });

  it('picks the farthest reachable station (fewest stops)', () => {
    const r = planLegFuelStops({
      legLengthKm: 900,
      rangeKm: 500,
      kmBurnedAtStart: 0,
      candidates: [c('near', 300), c('mid', 400), c('far', 450)],
    });
    expect(r.stops[0].candidate.id).toBe('far');
  });

  it('picks the only safe station when there is just one', () => {
    const r = planLegFuelStops({
      legLengthKm: 700,
      rangeKm: 400,
      kmBurnedAtStart: 0,
      candidates: [c('onlyone', 350)], // reachable & needed
    });
    expect(r.kind).toBe('planned');
    expect(r.stops.map((s) => s.candidate.id)).toEqual(['onlyone']);
  });

  it('flags a gap when no station is reachable within range', () => {
    const r = planLegFuelStops({
      legLengthKm: 600,
      rangeKm: 250,
      kmBurnedAtStart: 0,
      candidates: [c('toofar', 400)],
    });
    expect(r.kind).toBe('gap');
    if (r.kind !== 'gap') throw new Error('expected a gap');
    expect(r.gapDetail).toMatch(/400 km/);
  });

  it('accounts for fuel already burned entering the leg', () => {
    const r = planLegFuelStops({
      legLengthKm: 400,
      rangeKm: 500,
      kmBurnedAtStart: 300, // only 200 km of reach left at leg start
      candidates: [c('a', 150), c('b', 250)],
    });
    expect(r.kind).toBe('planned');
    // 250 is unreachable (>200), so it must take 150.
    expect(r.stops.map((s) => s.candidate.id)).toEqual(['a']);
  });

  it('attaches a forced-stop reason before a long dry void, then flags the gap', () => {
    const r = planLegFuelStops({
      legLengthKm: 700,
      rangeKm: 300,
      kmBurnedAtStart: 0,
      candidates: [c('a', 100), c('b', 200), c('c', 550)],
    });
    // Tops up at 200 (350 km void to the next fuel) with an honest reason…
    expect(r.stops[0].candidate.id).toBe('b');
    expect(r.stops[0].reason).toMatch(/350 km away/);
    // …and the 350 km hop past the 300 km range is a genuine gap warning.
    expect(r.kind).toBe('gap');
    if (r.kind !== 'gap') throw new Error('expected a gap');
    expect(r.gapDetail).toMatch(/350 km/);
  });

  /**
   * The -1896 km bug, as the planner saw it. Reproduced from trip `ab824cde`
   * leg 11 on 2026-09-09: range 500 km, and a walk-back that claimed 2,396 km
   * already burned because days 2, 4, 5, 7 and 9 had never been opened and so
   * carried no fuel stop. A station sat 44 km along the leg.
   */
  describe('tank state that cannot be true', () => {
    it('reports the real trip ab824cde numbers as tank_state_invalid, not a gap', () => {
      const r = planLegFuelStops({
        legLengthKm: 817.5,
        rangeKm: 500,
        kmBurnedAtStart: 2396.5,
        candidates: [c('44km-away', 44), c('further', 300)],
      });
      expect(r.kind).toBe('tank_state_invalid');
      if (r.kind !== 'tank_state_invalid') throw new Error('expected tank_state_invalid');
      expect(r.burnedKm).toBeCloseTo(2396.5);
      expect(r.rangeKm).toBe(500);
      expect(r.stops).toHaveLength(0);
    });

    it('never emits the negative-range sentence for any burn beyond range', () => {
      // The specific string a driver was shown. It must be unreachable now, at
      // every burn past the range rather than at the one value we happened to
      // reproduce.
      for (const burned of [500, 501, 750, 2396.5, 10_000]) {
        const r = planLegFuelStops({
          legLengthKm: 800,
          rangeKm: 500,
          kmBurnedAtStart: burned,
          candidates: [c('a', 44), c('b', 400)],
        });
        expect(r.kind).toBe('tank_state_invalid');
        const detail = r.kind === 'gap' ? r.gapDetail : '';
        expect(detail).not.toMatch(/beyond safe range \(-/);
      }
    });

    it('still plans normally with a single kilometre of range left', () => {
      // The guard is `<= 0`, so 499 burned against a 500 km range is SANE and
      // must go down the ordinary path. A guard written as `< range` would
      // swallow this and hide real planning; here the 0.5 km station is within
      // the 1 km of reach, so Finn takes it, refuels, and carries on.
      const r = planLegFuelStops({
        legLengthKm: 800,
        rangeKm: 500,
        kmBurnedAtStart: 499,
        candidates: [c('a', 0.5), c('b', 400)],
      });
      expect(r.kind).toBe('planned');
      expect(r.stops.map((s) => s.candidate.id)).toEqual(['a', 'b']);
    });

    it('still raises a REAL gap when the tank is sane but the void is long', () => {
      // The guard must not have eaten the honest warning: 1 km of reach and the
      // nearest station 400 km away is genuine geography, not broken arithmetic.
      const r = planLegFuelStops({
        legLengthKm: 800,
        rangeKm: 500,
        kmBurnedAtStart: 499,
        candidates: [c('b', 400)],
      });
      expect(r.kind).toBe('gap');
      if (r.kind !== 'gap') throw new Error('expected a gap');
      expect(r.gapDetail).toMatch(/400 km ahead/);
    });

    it('treats an exactly-empty tank as invalid rather than a zero-range gap', () => {
      const r = planLegFuelStops({
        legLengthKm: 100,
        rangeKm: 500,
        kmBurnedAtStart: 500,
        candidates: [c('a', 50)],
      });
      expect(r.kind).toBe('tank_state_invalid');
    });
  });
});
