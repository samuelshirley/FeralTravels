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
    expect(r.gap).toBe(false);
  });

  it('places stops greedily across a long leg', () => {
    const r = planLegFuelStops({
      legLengthKm: 600,
      rangeKm: 250,
      kmBurnedAtStart: 0,
      candidates: [c('a', 180), c('b', 360), c('d', 540)],
    });
    expect(r.gap).toBe(false);
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
    expect(r.gap).toBe(false);
    expect(r.stops.map((s) => s.candidate.id)).toEqual(['onlyone']);
  });

  it('flags a gap when no station is reachable within range', () => {
    const r = planLegFuelStops({
      legLengthKm: 600,
      rangeKm: 250,
      kmBurnedAtStart: 0,
      candidates: [c('toofar', 400)],
    });
    expect(r.gap).toBe(true);
    expect(r.gapDetail).toMatch(/400 km/);
  });

  it('accounts for fuel already burned entering the leg', () => {
    const r = planLegFuelStops({
      legLengthKm: 400,
      rangeKm: 500,
      kmBurnedAtStart: 300, // only 200 km of reach left at leg start
      candidates: [c('a', 150), c('b', 250)],
    });
    expect(r.gap).toBe(false);
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
    expect(r.gap).toBe(true);
    expect(r.gapDetail).toMatch(/350 km/);
  });
});
