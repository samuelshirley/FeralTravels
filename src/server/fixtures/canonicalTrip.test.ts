import { describe, it, expect } from 'vitest';
import { decodePolyline, haversineKm } from '@/lib/polyline';
import {
  CANONICAL_BASE_DAYS,
  CANONICAL_DRIVING_DAYS,
  CANONICAL_LEGS,
  CANONICAL_TOTAL_KM,
  resolveCanonicalTrip,
} from './canonicalTrip';
import { seededTripStartISO } from '@/app/api/test/seedDates';

/**
 * The fixture has to be a trip the app could have produced, and it has to stay
 * one forever.
 *
 * A fixture is the only test data nobody looks at twice. It gets written once,
 * against a real trip, and then every spec downstream inherits whatever is wrong
 * with it — which is how the previous one ended up asserting "seeded legs have
 * no intermediate stops" as though that were a property of trips rather than a
 * property of the seed. These tests are the fixture's own contract: coherent
 * now, and still in the future in five years.
 */
describe('canonical trip fixture', () => {
  it('is the twelve-day shape it was extracted from', () => {
    expect(CANONICAL_LEGS).toHaveLength(12);
    expect(CANONICAL_DRIVING_DAYS).toBe(6);
    expect(CANONICAL_BASE_DAYS).toBe(6);
    expect(Math.round(CANONICAL_TOTAL_KM)).toBe(2832);
  });

  it('numbers its legs contiguously from zero', () => {
    expect(CANONICAL_LEGS.map((l) => l.sortOrder)).toEqual([...Array(12).keys()]);
  });

  /**
   * The invariant the "scrambled trip" incident was about: a driver cannot
   * teleport. Every leg starts where the previous one ended.
   */
  it('is geographically continuous — no leg starts where the last one did not end', () => {
    for (let i = 1; i < CANONICAL_LEGS.length; i++) {
      const prev = CANONICAL_LEGS[i - 1];
      const leg = CANONICAL_LEGS[i];
      expect(leg.startName, `leg ${i} does not start where leg ${i - 1} ended`).toBe(prev.endName);
      const gap = haversineKm(
        { lat: prev.endLat!, lng: prev.endLng! },
        { lat: leg.startLat!, lng: leg.startLng! }
      );
      expect(gap, `leg ${i} starts ${gap.toFixed(1)} km from where leg ${i - 1} ended`).toBeLessThan(1);
    }
  });

  /** A base day is a day you do not drive. If it moves, it is not a base day. */
  it('base days start and end in the same place and log no driving', () => {
    for (const leg of CANONICAL_LEGS.filter((l) => l.legType === 'rest')) {
      expect(leg.startName).toBe(leg.endName);
      expect(leg.distanceKm).toBeNull();
      expect(leg.driveTimeMinutes).toBeNull();
    }
  });

  it('driving days carry a distance and a duration', () => {
    for (const leg of CANONICAL_LEGS.filter((l) => l.legType === 'drive')) {
      expect(leg.distanceKm).toBeGreaterThan(0);
      expect(leg.driveTimeMinutes).toBeGreaterThan(0);
    }
  });

  /**
   * The whole reason this fixture was built: stops. The old one had none, so
   * nothing about fuel, maps links or stop rendering could be tested at all.
   */
  it('carries real fuel stops with the fields the maps link needs', () => {
    const stops = CANONICAL_LEGS.flatMap((l) => l.stops);
    expect(stops.length).toBeGreaterThan(0);
    for (const s of stops) {
      expect(s.name).toBeTruthy();
      expect(s.lat).not.toBeNull();
      expect(s.lng).not.toBeNull();
      // Without this the "open in Maps" link degrades to a coordinate pin.
      expect(s.googleMapsUri).toMatch(/^https?:\/\//);
      expect(s.distanceFromStartKm).not.toBeNull();
    }
  });

  /**
   * All three cache branches in one seed — that is what makes the lazy-fuel
   * contract testable end to end without three different fixtures.
   */
  it('covers every fuel cache state', () => {
    const states = new Set(CANONICAL_LEGS.map((l) => l.fuelStatus));
    expect(states).toContain('ready');
    expect(states).toContain('none');
    expect(states).toContain('no_stations_found');
  });

  it('has exactly one leg whose cache is fresh enough to suppress a re-search', () => {
    // FUEL_CACHE_TTL_MS is 48h; "fresh" here means comfortably inside it.
    const fresh = CANONICAL_LEGS.filter(
      (l) => l.fuelCacheAgeHours != null && l.fuelCacheAgeHours < 24
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0].fuelStatus).toBe('ready');
    expect(fresh[0].stops.length).toBeGreaterThan(0);
  });

  /**
   * Geometry is the difference between a fixture the native map can draw and a
   * screenful of scattered dots — the map renders only what it is given, which
   * is how the missing-`geometry` clone bug stayed hidden on the web.
   *
   * Driving days carry the real road. Base days carry a SINGLE-POINT stub, and
   * that is not a defect: the source trip stores one too, because a day you do
   * not drive has a position and no path. Asserting the distinction is the
   * point — a base day that grew a route would mean something re-planned it.
   */
  it('decodes every leg geometry back to the road it came from', () => {
    const trip = resolveCanonicalTrip();
    for (const leg of trip.legs) {
      expect(leg.geometry, `leg ${leg.sortOrder} has no geometry`).toBeTruthy();
      const points = decodePolyline(leg.geometry!);

      if (leg.legType === 'rest') {
        expect(points, `base day ${leg.sortOrder} should be a single point`).toHaveLength(1);
      } else {
        // A real road between two cities is hundreds of vertices, not a
        // straight line someone substituted for one.
        expect(points.length, `leg ${leg.sortOrder} has only ${points.length} vertices`).toBeGreaterThan(20);
      }

      // The polyline must start where the leg says it does — a mis-encoded
      // fixture draws a route through the wrong country and still looks
      // plausible in a screenshot.
      const gap = haversineKm(points[0], { lat: leg.startLat!, lng: leg.startLng! });
      expect(gap, `leg ${leg.sortOrder} geometry starts ${gap.toFixed(1)} km from its own start`).toBeLessThan(2);
    }
  });

  /** The encoded road must agree with the distance the leg claims. */
  it('geometry length agrees with the stated distance', () => {
    for (const leg of resolveCanonicalTrip().legs) {
      if (leg.legType !== 'drive' || leg.distanceKm == null) continue;
      const points = decodePolyline(leg.geometry!);
      let km = 0;
      for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1], points[i]);
      // Generous: haversine over polyline vertices under-reads a real road, and
      // the stored distance came from the routing provider. This is a sanity
      // check against a swapped or truncated polyline, not a precision test.
      expect(km, `leg ${leg.sortOrder}: geometry ${km.toFixed(0)} km vs stated ${leg.distanceKm} km`)
        .toBeGreaterThan(leg.distanceKm * 0.8);
      expect(km).toBeLessThan(leg.distanceKm * 1.2);
    }
  });

  /**
   * THE rule. `seedDates.ts` argues it for the trip's dates; it holds for this
   * fixture by construction, because there is no calendar date in it to rot.
   */
  it('is always in the future, whenever it is seeded', () => {
    for (const when of ['2026-08-28', '2027-03-02', '2031-12-31']) {
      const now = new Date(`${when}T12:00:00Z`);
      const trip = resolveCanonicalTrip(seededTripStartISO(now), now);
      expect(trip.startISO > when, `seeded on ${when}, trip starts ${trip.startISO}`).toBe(true);
      expect(trip.endISO > trip.startISO).toBe(true);
      // Every single day of it, not just the first — a spec about the planning
      // flow must not find half the trip in the collapsed "behind you" section.
      for (const leg of trip.legs) expect(leg.date > when).toBe(true);
    }
  });

  it('advances exactly one calendar day per leg', () => {
    const trip = resolveCanonicalTrip('2026-09-15');
    expect(trip.legs.map((l) => l.date)).toEqual([
      '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
      '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22',
      '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26',
    ]);
    expect(trip.endISO).toBe('2026-09-26');
  });

  it('resolves the fuel cache against now, so fresh keeps meaning fresh', () => {
    const now = new Date('2030-01-01T00:00:00Z');
    const trip = resolveCanonicalTrip(undefined, now);
    const fresh = trip.legs.find((l) => l.fuelCacheAgeHours === 1)!;
    expect(now.getTime() - fresh.fuelStopsUpdatedAt!.getTime()).toBe(60 * 60 * 1000);
    for (const leg of trip.legs) {
      if (leg.fuelCacheAgeHours == null) expect(leg.fuelStopsUpdatedAt).toBeNull();
      else expect(leg.fuelStopsUpdatedAt!.getTime()).toBeLessThan(now.getTime());
    }
  });

  /** No user, no transcript, no timestamps — nothing that ties it to a person. */
  it('carries nothing personal', () => {
    const raw = JSON.stringify(CANONICAL_LEGS);
    expect(raw).not.toMatch(/@/);
    expect(raw).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/);
  });
});
