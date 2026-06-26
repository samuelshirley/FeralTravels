import { describe, it, expect } from 'vitest';
import {
  reachableMaxKm,
  comfortMaxKm,
  isSafe,
  isInComfort,
  planNextStop,
  type TankState,
  type FuelCandidate,
} from './range';

// Sam's Hilux: comfortable 500, hard-max 550, 200 km already burned.
const tank: TankState = {
  comfortableRangeKm: 500,
  hardMaxRangeKm: 550,
  kmBurnedSinceLastRefuel: 200,
};

describe('range maxima', () => {
  it('reachable and comfort maxima subtract the burn', () => {
    expect(reachableMaxKm(tank)).toBe(350); // 550 - 200
    expect(comfortMaxKm(tank)).toBe(300); // 500 - 200
  });

  it('never goes negative once burn exceeds range', () => {
    const dry: TankState = { comfortableRangeKm: 500, hardMaxRangeKm: 550, kmBurnedSinceLastRefuel: 600 };
    expect(reachableMaxKm(dry)).toBe(0);
    expect(comfortMaxKm(dry)).toBe(0);
  });
});

describe('isSafe / isInComfort', () => {
  it('classifies the comfort, stretch, and unreachable zones', () => {
    expect(isInComfort(280, tank)).toBe(true); // within C
    expect(isSafe(280, tank)).toBe(true);

    expect(isInComfort(330, tank)).toBe(false); // stretch zone (C<x<=H)
    expect(isSafe(330, tank)).toBe(true);

    expect(isSafe(360, tank)).toBe(false); // past H
  });

  it('rejects negative distances', () => {
    expect(isSafe(-5, tank)).toBe(false);
  });
});

describe('planNextStop', () => {
  it('picks the farthest candidate within comfort (fewest stops, no early fill)', () => {
    const candidates: FuelCandidate[] = [
      { id: 'a', distanceAheadKm: 120 },
      { id: 'b', distanceAheadKm: 280 }, // farthest in comfort (≤300)
      { id: 'c', distanceAheadKm: 330 }, // stretch zone, should be passed over
    ];
    const plan = planNextStop(candidates, tank);
    expect(plan.pick?.id).toBe('b');
    expect(plan.inComfort).toBe(true);
    expect(plan.gap).toBe(false);
  });

  it('falls back to the stretch zone when nothing is within comfort', () => {
    const candidates: FuelCandidate[] = [
      { id: 'c', distanceAheadKm: 330 }, // within H (350) but past C (300)
      { id: 'd', distanceAheadKm: 345 },
    ];
    const plan = planNextStop(candidates, tank);
    expect(plan.pick?.id).toBe('d'); // farthest still-safe
    expect(plan.inComfort).toBe(false);
    expect(plan.gap).toBe(false);
  });

  it('flags a gap when every candidate is past H', () => {
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
