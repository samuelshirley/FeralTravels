import { describe, it, expect } from 'vitest';
import {
  alongKmOnLeg,
  fuelNeededAtLegStartKm,
  planLegFuelStops,
  type PlacementCandidate,
  type PlacementResult,
} from './plan';
import { kmBurnedSinceLastRefuel, type LegFuelHistory } from '@/lib/penny/fuelTankState';
import trip from './__fixtures__/spain-da203241.json';

/**
 * The real trip that broke Finn: 14 days around Spain's national parks on a
 * 550 km range (see the fixture's `_about`). Sourced day by day it produced a
 * "beyond safe range (20 km)" warning, two "impossible tank state" failures,
 * and only two fuel stops in ~3,100 km.
 *
 * `replay` sources every drive day oldest first — the order the server's
 * cascade (`sourcingOrder.ts`) guarantees whichever day is opened — making the
 * same decisions as `planOneLeg` in `server/fuel.ts`: the tank walk, the
 * look-ahead to the next drive day, the no-stop early exit, then placement.
 */
interface FixtureLeg {
  sortOrder: number;
  legType: string;
  title: string;
  distanceKm: number | null;
  polylineKm?: number;
  stationsAlongPolylineKm?: number[];
}

const R = trip.rangeKm;
const LEGS = trip.legs as FixtureLeg[];

interface DayResult {
  leg: FixtureLeg;
  burnedAtStartKm: number;
  reserveKm: number;
  result: PlacementResult | null; // null = early exit, no stop needed
}

function candidates(leg: FixtureLeg, aligned: boolean): PlacementCandidate[] {
  return (leg.stationsAlongPolylineKm ?? []).map((km, i) => ({
    id: `${leg.sortOrder}-${i}`,
    alongKm: aligned ? alongKmOnLeg(km, leg.polylineKm!, leg.distanceKm!) : km,
  }));
}

function replay({ lookAhead }: { lookAhead: boolean }): DayResult[] {
  const history: LegFuelHistory[] = [];
  const days: DayResult[] = [];
  LEGS.forEach((leg, i) => {
    if (leg.legType !== 'drive') {
      history.push({ distanceKm: null, latestFuelDistanceKm: null });
      return;
    }
    const legKm = lookAhead ? leg.distanceKm! : leg.polylineKm!;
    const burnedAtStartKm = kmBurnedSinceLastRefuel([...history].reverse());
    const next = LEGS.slice(i + 1).find((l) => l.legType === 'drive');
    const leftWithoutStops = R - burnedAtStartKm - legKm;
    const reserveKm =
      !lookAhead || !next || leftWithoutStops >= next.distanceKm!
        ? 0
        : fuelNeededAtLegStartKm(next.distanceKm!, candidates(next, true), R);

    const result =
      burnedAtStartKm + legKm + reserveKm <= R
        ? null
        : planLegFuelStops({
            legLengthKm: legKm,
            rangeKm: R,
            kmBurnedAtStart: burnedAtStartKm,
            candidates: candidates(leg, lookAhead),
            arrivalReserveKm: reserveKm,
          });
    days.push({ leg, burnedAtStartKm, reserveKm, result });

    // What the server writes back: the stops (the walk reads the last one, at
    // its stored whole km) and, for a warned leg, `no_stations_found`.
    const stops = result?.stops ?? [];
    history.push({
      distanceKm: leg.distanceKm,
      latestFuelDistanceKm: stops.length ? Math.round(stops[stops.length - 1].candidate.alongKm) : null,
      unplannableRefuelAtEnd: result?.kind === 'gap',
    });
  });
  return days;
}

const day = (days: DayResult[], title: string) => {
  const d = days.find((x) => x.leg.title.startsWith(title));
  if (!d) throw new Error(`no day ${title}`);
  return d;
};

describe('Spain trip da203241', () => {
  it('reproduces the reported failures when each day is planned in isolation', () => {
    // Guards the fixture: if these stop reproducing, the test below proves nothing.
    const days = replay({ lookAhead: false });

    const vitoria = day(days, 'Cabrales');
    expect(vitoria.result?.kind).toBe('gap');
    expect(vitoria.result?.kind === 'gap' && vitoria.result.gapDetail).toMatch(
      /beyond safe range \(20 km\)/
    );

    // Madrid → Isla Mayor tops up 3 km in and drives 549 of 550 km...
    const islaMayor = day(days, 'Madrid, Spain → Isla Mayor');
    expect(islaMayor.result?.stops.map((s) => Math.round(s.candidate.alongKm))).toEqual([3]);
    // ...so the next day starts on an empty tank.
    expect(day(days, 'Isla Mayor').result?.kind).toBe('tank_state_invalid');
  });

  describe('with the next-day look-ahead', () => {
    const days = replay({ lookAhead: true });

    it('plans every day: no gap, no impossible tank state', () => {
      for (const d of days) {
        expect(d.result?.kind ?? 'planned', d.leg.title).toBe('planned');
      }
    });

    it('starts every day with enough fuel to reach its first station', () => {
      for (const d of days) {
        const needed = fuelNeededAtLegStartKm(d.leg.distanceKm!, candidates(d.leg, true), R);
        expect(R - d.burnedAtStartKm, d.leg.title).toBeGreaterThanOrEqual(needed);
      }
    });

    it('places enough stops for ~3,100 km on a 550 km range', () => {
      const totalKm = days.reduce((sum, d) => sum + d.leg.distanceKm!, 0);
      const stops = days.reduce((sum, d) => sum + (d.result?.stops.length ?? 0), 0);
      // A full tank covers the first 550 km; every 550 after needs a refill.
      expect(stops).toBeGreaterThanOrEqual(Math.ceil((totalKm - R) / R));
    });

    it('tops up before Cabrales for the next morning, and says why', () => {
      // Monzón → Cabrales fits in the tank on its own; the drive out of
      // Cabrales has no fuel for its first 28 km.
      const monzon = day(days, 'Monzón');
      expect(monzon.reserveKm).toBe(28);
      expect(monzon.result?.stops).toHaveLength(1);
      expect(monzon.result?.stops[0].reason).toMatch(/km away, on the next day's drive/);
    });
  });
});
