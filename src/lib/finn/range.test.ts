import { describe, it, expect } from 'vitest';
import {
  reachableMaxKm,
  isSafe,
  planNextStop,
  type TankState,
  type FuelCandidate,
} from './range';

// Sam's Hilux: fuel range 500, 200 km already burned.
const tank: TankState = {
  rangeKm: 500,
  kmBurnedSinceLastRefuel: 200,
};

describe('range maxima', () => {
  it('reachable max subtracts the burn', () => {
    expect(reachableMaxKm(tank)).toBe(300); // 500 - 200
  });

  it('never goes negative once burn exceeds range', () => {
    const dry: TankState = { rangeKm: 500, kmBurnedSinceLastRefuel: 600 };
    expect(reachableMaxKm(dry)).toBe(0);
  });
});

describe('isSafe', () => {
  it('classifies the reachable and unreachable zones', () => {
    expect(isSafe(280, tank)).toBe(true); // within R
    expect(isSafe(330, tank)).toBe(false); // past R
  });

  it('rejects negative distances', () => {
    expect(isSafe(-5, tank)).toBe(false);
  });
});

describe('planNextStop', () => {
  it('picks the farthest candidate within range (fewest stops, no early fill)', () => {
    const candidates: FuelCandidate[] = [
      { id: 'a', distanceAheadKm: 120 },
      { id: 'b', distanceAheadKm: 280 }, // farthest in range (≤300)
      { id: 'c', distanceAheadKm: 330 }, // past R, should be passed over
    ];
    const plan = planNextStop(candidates, tank);
    expect(plan.pick?.id).toBe('b');
    expect(plan.gap).toBe(false);
  });

  it('flags a gap when every candidate is past R', () => {
    const candidates: FuelCandidate[] = [
      { id: 'far', distanceAheadKm: 400 },
      { id: 'farther', distanceAheadKm: 500 },
    ];
    const plan = planNextStop(candidates, tank);
    expect(plan.pick).toBeNull();
    expect(plan.gap).toBe(true);
  });

  it('flags a gap on an empty candidate set', () => {
    const plan = planNextStop([], tank);
    expect(plan.gap).toBe(true);
    expect(plan.pick).toBeNull();
  });

  it('preserves candidate subtype fields on the pick', () => {
    interface Priced extends FuelCandidate {
      price: number;
    }
    const candidates: Priced[] = [
      { id: 'a', distanceAheadKm: 100, price: 1.99 },
      { id: 'b', distanceAheadKm: 250, price: 1.82 },
    ];
    const plan = planNextStop(candidates, tank);
    expect(plan.pick?.price).toBe(1.82);
  });
});
