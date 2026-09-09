import { describe, expect, it } from 'vitest';

import { legsNeedingSourcingBefore, type LegSourcingState } from './sourcingOrder';

/** Terse leg builder — defaults are a sourced, stopless drive day. */
const leg = (
  sortOrder: number,
  over: Partial<LegSourcingState> = {}
): LegSourcingState => ({
  id: `leg-${sortOrder}`,
  sortOrder,
  legType: 'drive',
  fuelStatus: 'ready',
  hasFuelStop: false,
  ...over,
});

const ids = (n: number[]) => n.map((i) => `leg-${i}`);

describe('legsNeedingSourcingBefore', () => {
  it('opening day 12 with days 3-9 unsourced yields 3..9, oldest first', () => {
    const preceding = [
      leg(0, { hasFuelStop: true }),
      ...[1, 2].map((i) => leg(i)),
      ...[3, 4, 5, 6, 7, 8, 9].map((i) => leg(i, { fuelStatus: 'none' })),
      ...[10, 11].map((i) => leg(i)),
    ];
    const plan = legsNeedingSourcingBefore(preceding);
    expect(plan.toSource).toEqual(ids([3, 4, 5, 6, 7, 8, 9]));
    expect(plan.blockedBy).toEqual([]);
  });

  it('stops at the last real fuel stop — a refuel on day 6 yields 7..9', () => {
    const preceding = [
      leg(0, { hasFuelStop: true }),
      ...[3, 4, 5].map((i) => leg(i, { fuelStatus: 'none' })),
      leg(6, { fuelStatus: 'ready', hasFuelStop: true }),
      ...[7, 8, 9].map((i) => leg(i, { fuelStatus: 'none' })),
    ];
    expect(legsNeedingSourcingBefore(preceding).toSource).toEqual(ids([7, 8, 9]));
  });

  it('skips rest days — they burn nothing', () => {
    const preceding = [
      leg(0, { hasFuelStop: true }),
      leg(1, { legType: 'rest', fuelStatus: 'none' }),
      leg(2, { fuelStatus: 'none' }),
      leg(3, { legType: 'rest', fuelStatus: 'none' }),
    ];
    expect(legsNeedingSourcingBefore(preceding).toSource).toEqual(ids([2]));
  });

  it('reports an in-flight leg instead of returning it', () => {
    // Two requests planning one leg concurrently would race on its stops.
    for (const status of ['computing', 'pending']) {
      const preceding = [
        leg(0, { hasFuelStop: true }),
        leg(1, { fuelStatus: status }),
        leg(2, { fuelStatus: 'none' }),
      ];
      const plan = legsNeedingSourcingBefore(preceding);
      expect(plan.toSource).toEqual(ids([2]));
      expect(plan.blockedBy).toEqual(ids([1]));
    }
  });

  it('re-sources a failed leg — it is an unknown, not an answer', () => {
    const preceding = [leg(0, { hasFuelStop: true }), leg(1, { fuelStatus: 'failed' })];
    expect(legsNeedingSourcingBefore(preceding).toSource).toEqual(ids([1]));
  });

  it('leaves a searched-but-stopless day alone', () => {
    // `ready` with no stop means "no stop needed on this day" — a real answer,
    // and the burn walking through it at full distance is CORRECT. Re-sourcing
    // it every time would make the cascade unbounded for no gain.
    const preceding = [
      leg(0, { hasFuelStop: true }),
      leg(1, { fuelStatus: 'ready' }),
      leg(2, { fuelStatus: 'no_stations_found' }),
    ];
    expect(legsNeedingSourcingBefore(preceding).toSource).toEqual([]);
  });

  it('stops at a declared tank state, which re-baselines the tank', () => {
    const preceding = [
      leg(0, { fuelStatus: 'none' }),
      leg(1, { fuelStatus: 'none' }),
      leg(2, { fuelStatus: 'none' }),
      leg(3, { fuelStatus: 'none' }),
    ];
    expect(legsNeedingSourcingBefore(preceding, 'leg-2').toSource).toEqual(ids([3]));
  });

  it('walks back to the trip start when nothing has ever refuelled', () => {
    const preceding = [0, 1, 2].map((i) => leg(i, { fuelStatus: 'none' }));
    expect(legsNeedingSourcingBefore(preceding).toSource).toEqual(ids([0, 1, 2]));
  });

  it('returns nothing for the first leg of a trip', () => {
    expect(legsNeedingSourcingBefore([])).toEqual({ toSource: [], blockedBy: [] });
  });

  it('reproduces trip ab824cde: opening day 11 sources 2, 4, 5, 7, 9', () => {
    // The real shape — drive/rest alternating, one fuel stop on day 0.
    const preceding: LegSourcingState[] = [
      leg(0, { fuelStatus: 'ready', hasFuelStop: true }),
      leg(1, { legType: 'rest', fuelStatus: 'none' }),
      leg(2, { fuelStatus: 'none' }),
      leg(3, { legType: 'rest', fuelStatus: 'none' }),
      leg(4, { fuelStatus: 'none' }),
      leg(5, { fuelStatus: 'none' }),
      leg(6, { legType: 'rest', fuelStatus: 'none' }),
      leg(7, { fuelStatus: 'none' }),
      leg(8, { legType: 'rest', fuelStatus: 'none' }),
      leg(9, { fuelStatus: 'none' }),
      leg(10, { legType: 'rest', fuelStatus: 'none' }),
    ];
    expect(legsNeedingSourcingBefore(preceding).toSource).toEqual(ids([2, 4, 5, 7, 9]));
  });
});
