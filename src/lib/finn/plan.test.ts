import { describe, it, expect } from 'vitest';
import { planLegFuelStops, type PlacementCandidate } from './plan';

const c = (id: string, alongKm: number, pricePerLitre?: number): PlacementCandidate => ({
  id,
  alongKm,
  pricePerLitre,
});

describe('planLegFuelStops', () => {
  it('places no stop when the leg fits on the current tank', () => {
    const r = planLegFuelStops({
      legLengthKm: 300,
      comfortableRangeKm: 400,
      hardMaxRangeKm: 500,
      kmBurnedAtStart: 0,
      candidates: [c('a', 150)],
    });
    expect(r.stops).toHaveLength(0);
    expect(r.gap).toBe(false);
  });

  it('places stops greedily across a long leg', () => {
    const r = planLegFuelStops({
      legLengthKm: 600,
      comfortableRangeKm: 200,
      hardMaxRangeKm: 250,
      kmBurnedAtStart: 0,
      candidates: [c('a', 180), c('b', 360), c('d', 540)],
    });
    expect(r.gap).toBe(false);
    expect(r.stops.map((s) => s.candidate.id)).toEqual(['a', 'b']);
  });

  it('prefers a priced station and picks the cheapest in the comfort pool', () => {
    const r = planLegFuelStops({
      legLengthKm: 900,
      comfortableRangeKm: 500,
      hardMaxRangeKm: 600,
      kmBurnedAtStart: 0,
      candidates: [c('near', 300, 1.8), c('cheap', 400, 1.6), c('far', 450, 1.7)],
    });
    expect(r.stops[0].candidate.id).toBe('cheap');
  });

  it('falls back to the farthest reachable when no candidate is priced', () => {
    const r = planLegFuelStops({
      legLengthKm: 900,
      comfortableRangeKm: 500,
      hardMaxRangeKm: 600,
      kmBurnedAtStart: 0,
      candidates: [c('near', 300), c('mid', 400), c('far', 450)],
    });
    expect(r.stops[0].candidate.id).toBe('far');
  });

  it('still picks an unpriced station when it is the only safe option', () => {
    const r = planLegFuelStops({
      legLengthKm: 700,
      comfortableRangeKm: 400,
      hardMaxRangeKm: 500,
      kmBurnedAtStart: 0,
      candidates: [c('onlyone', 350)], // unpriced, but reachable & needed
    });
    expect(r.gap).toBe(false);
    expect(r.stops.map((s) => s.candidate.id)).toEqual(['onlyone']);
  });

  it('flags a gap when no station is reachable before the ceiling', () => {
    const r = planLegFuelStops({
      legLengthKm: 600,
      comfortableRangeKm: 200,
      hardMaxRangeKm: 250,
      kmBurnedAtStart: 0,
      candidates: [c('toofar', 400)],
    });
    expect(r.gap).toBe(true);
    expect(r.gapDetail).toMatch(/400 km/);
  });

  it('accounts for fuel already burned entering the leg', () => {
    const r = planLegFuelStops({
      legLengthKm: 400,
      comfortableRangeKm: 400,
      hardMaxRangeKm: 500,
      kmBurnedAtStart: 300, // only 200 km of reach left at leg start
      candidates: [c('a', 150), c('b', 250)],
    });
    expect(r.gap).toBe(false);
    // 250 is unreachable (>200), so it must take 150.
    expect(r.stops.map((s) => s.candidate.id)).toEqual(['a']);
  });

  it('attaches a forced-stop reason when a long dry stretch follows', () => {
    const r = planLegFuelStops({
      legLengthKm: 700,
      comfortableRangeKm: 300,
      hardMaxRangeKm: 400,
      kmBurnedAtStart: 0,
      candidates: [c('a', 100), c('b', 200), c('c', 550)],
    });
    expect(r.gap).toBe(false);
    // Stops at 200 (forced — 350 km void to the next fuel) then 550.
    expect(r.stops[0].candidate.id).toBe('b');
    expect(r.stops[0].reason).toMatch(/350 km away/);
  });
});
