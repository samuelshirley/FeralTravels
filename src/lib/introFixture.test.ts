import { describe, expect, it } from 'vitest';
import { computePlanSummary } from '@/lib/penny/planSummary';
import { kmBurnedSinceLastRefuel, type LegFuelHistory } from '@/lib/penny/fuelTankState';
import type { LegWithDetails } from '@/types/trip';
import {
  INTRO_ADDED_STOP,
  INTRO_EXAMPLE_MESSAGE,
  INTRO_FUEL_DAY_INDEX,
  INTRO_LEGS,
  INTRO_RANGE_KM,
  introDriveLeg,
  introLegDateISO,
  introPlanSummary,
  introStartISO,
  type IntroLeg,
} from './introFixture';
import trip from './finn/__fixtures__/spain-da203241.json';

/**
 * The intro's trip is real data (see the header of introFixture.ts). These
 * hold it to that: the card it draws is the card the server would compute,
 * the route is the planned trip's route, and no day runs the tank dry.
 */

function asLeg(l: IntroLeg, i: number, startISO: string): LegWithDetails {
  const drive = l.type === 'drive';
  return {
    id: `intro-${i}`,
    range_remaining_start_km: null,
    trip_id: 'intro',
    sort_order: i,
    leg_type: l.type,
    title: drive ? `${l.start} → ${l.end}` : l.title,
    label: null,
    segment_index: null,
    segment_name: null,
    start_name: drive ? l.start : l.at,
    end_name: drive ? l.end : l.at,
    start_lat: null,
    start_lng: null,
    end_lat: null,
    end_lng: null,
    dates: null,
    date_iso: introLegDateISO(startISO, i),
    distance_km: drive ? l.distanceKm : null,
    drive_time_minutes: drive ? l.driveMinutes : null,
    terrain: null,
    overnight: null,
    status: 'planning',
    color: null,
    notes: null,
    fuel_status: 'none',
    fuel_plan_error: null,
    fuel_stops_updated_at: null,
    continuity_warning: null,
    geometry: null,
    created_at: '2026-11-02T00:00:00.000Z',
    updated_at: '2026-11-02T00:00:00.000Z',
    costs: [],
    links: [],
    routes: [],
    stops: [],
    tasks: [],
    parsedNotes: [],
  };
}

describe('the intro trip', () => {
  const start = '2026-11-16';

  it("its plan card is exactly what computePlanSummary makes of the same legs", () => {
    const legs = INTRO_LEGS.map((l, i) => asLeg(l, i, start));
    expect(introPlanSummary(start)).toEqual(computePlanSummary({ legs, tripStartISO: start }));
  });

  it('is the route Penny planned for trip da203241, day for day', () => {
    // Same count, same order of drive and base days, same overnight towns.
    const fixture = trip.legs as Array<{ legType: string; title: string }>;
    expect(INTRO_LEGS.map((l) => l.type)).toEqual(fixture.map((l) => l.legType));
    INTRO_LEGS.forEach((l, i) => {
      const title = l.type === 'drive' ? `${l.start} → ${l.end}` : l.title;
      // The fixture spells two destinations by their park name; the intro keeps
      // the stored town names everywhere else.
      if (l.type === 'drive') {
        const [from, to] = fixture[i].title.split(' → ');
        expect(l.start === from || from.startsWith(l.start), `${title} vs ${fixture[i].title}`).toBe(true);
        expect(l.end === to || to.startsWith(l.end), `${title} vs ${fixture[i].title}`).toBe(true);
      } else {
        expect(title).toBe(fixture[i].title);
      }
    });
    expect(INTRO_RANGE_KM).toBe(trip.rangeKm);
  });

  it("its re-measured distances are within 12% of the planned trip's", () => {
    const fixture = trip.legs as Array<{ distanceKm: number | null }>;
    INTRO_LEGS.forEach((l, i) => {
      if (l.type !== 'drive') return;
      const planned = fixture[i].distanceKm!;
      expect(Math.abs(l.distanceKm - planned) / planned, `day ${i + 1}`).toBeLessThan(0.12);
    });
  });

  it('never runs the tank dry: every stretch between refuels fits the range', () => {
    // Walk the trip the way Finn's tank model does: full at the start, refilled
    // only at a fuel stop, base days burn nothing.
    const history: LegFuelHistory[] = [];
    for (const l of INTRO_LEGS) {
      if (l.type === 'rest') {
        history.push({ distanceKm: null, latestFuelDistanceKm: null });
        continue;
      }
      const burned = kmBurnedSinceLastRefuel([...history].reverse());
      let anchor = 0;
      let tank = INTRO_RANGE_KM - burned;
      for (const f of l.fuel) {
        expect(f.alongKm - anchor, `${l.start} → fuel at ${f.alongKm} km`).toBeLessThanOrEqual(tank);
        anchor = f.alongKm;
        tank = INTRO_RANGE_KM;
      }
      expect(l.distanceKm - anchor, `${l.start} → ${l.end}`).toBeLessThanOrEqual(tank);
      history.push({
        distanceKm: l.distanceKm,
        latestFuelDistanceKm: l.fuel.length ? l.fuel[l.fuel.length - 1].alongKm : null,
      });
    }
  });

  it('every stop sits on its day, in order, at a whole km', () => {
    for (const l of INTRO_LEGS) {
      if (l.type !== 'drive') continue;
      let last = 0;
      for (const f of l.fuel) {
        expect(Number.isInteger(f.alongKm)).toBe(true);
        expect(f.alongKm).toBeGreaterThan(last);
        expect(f.alongKm).toBeLessThan(l.distanceKm);
        last = f.alongKm;
      }
      expect(l.route.length).toBeGreaterThan(5);
    }
    const day4 = introDriveLeg(INTRO_ADDED_STOP.dayIndex);
    expect(INTRO_ADDED_STOP.alongKm).toBeGreaterThan(day4.fuel[day4.fuel.length - 1].alongKm);
    expect(INTRO_ADDED_STOP.alongKm).toBeLessThan(day4.distanceKm);
  });

  it('the two days the screens open have what the screens claim', () => {
    expect(introDriveLeg(INTRO_FUEL_DAY_INDEX).fuel).toHaveLength(1);
    expect(introDriveLeg(INTRO_ADDED_STOP.dayIndex).fuel.length).toBeGreaterThan(0);
    expect(INTRO_LEGS.slice(0, 3).map((l) => l.type)).toEqual(['drive', 'drive', 'rest']);
  });

  it('the example names its start, so onboarding can skip asking for one', () => {
    expect(INTRO_EXAMPLE_MESSAGE).toMatch(/\bfrom Madrid\b/);
    expect(introDriveLeg(0).start).toBe('Madrid');
  });

  it('starts two weeks out, in local time', () => {
    expect(introStartISO(new Date(2026, 10, 2, 23, 30))).toBe('2026-11-16');
    expect(introStartISO(new Date(2026, 11, 25))).toBe('2027-01-08');
  });
});
