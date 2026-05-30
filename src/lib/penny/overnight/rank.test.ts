/**
 * Tests for overnight candidate ranking. Pure function.
 *
 * These encode the calibration discriminator from real spots: a dog park with
 * an adjacent lot (Zürich Brunau, Lyon Grigny) should outrank a dog park with
 * NO lot (the bad Innsbruck suggestion), and fuel stations are excluded.
 */
import { describe, it, expect, vi } from 'vitest';

// `server-only` throws under the jsdom test env; stub it (hoisted above imports).
vi.mock('server-only', () => ({}));

import { rankOvernightCandidates } from './rank';
import type { OsmCandidate } from './overpass';
import type { LatLng } from './anchor';

function cand(partial: Partial<OsmCandidate> & Pick<OsmCandidate, 'osmId' | 'lat' | 'lng' | 'category'>): OsmCandidate {
  return {
    osmType: 'node',
    name: null,
    tags: {},
    surface: null,
    motorhomeFriendly: false,
    ...partial,
  };
}

// Anchor and a short straight route near it.
const ANCHOR: LatLng = [45.62, 4.72];
const ROUTE: LatLng[] = [
  [45.6, 4.7],
  [45.62, 4.72],
  [45.64, 4.74],
];

describe('rankOvernightCandidates', () => {
  it('ranks a dog park WITH an adjacent lot above one without', () => {
    // Good: dog park essentially co-located with a parking lot, on route.
    const goodDogPark = cand({ osmId: 1, lat: 45.62, lng: 4.72, category: 'dog_park' });
    const adjacentLot = cand({ osmId: 2, lat: 45.6201, lng: 4.7201, category: 'parking' });
    // Bad: dog park at a different on-route point with NO lot within range
    // (~3 km from the only lot), so the sole difference is lot adjacency.
    const badDogPark = cand({ osmId: 3, lat: 45.64, lng: 4.74, category: 'dog_park' });

    const ranked = rankOvernightCandidates({
      candidates: [badDogPark, goodDogPark, adjacentLot],
      anchor: ANCHOR,
      routePolyline: ROUTE,
    });

    const good = ranked.find((r) => r.candidate.osmId === 1)!;
    const bad = ranked.find((r) => r.candidate.osmId === 3)!;
    expect(good.hasAdjacentLot).toBe(true);
    expect(bad.hasAdjacentLot).toBe(false);
    expect(good.score).toBeGreaterThan(bad.score);
  });

  it('excludes fuel stations from the overnight shortlist', () => {
    const fuel = cand({ osmId: 10, lat: 45.62, lng: 4.72, category: 'fuel' });
    const lot = cand({ osmId: 11, lat: 45.62, lng: 4.72, category: 'parking' });
    const ranked = rankOvernightCandidates({
      candidates: [fuel, lot],
      anchor: ANCHOR,
      routePolyline: ROUTE,
    });
    expect(ranked.map((r) => r.candidate.osmId)).not.toContain(10);
    expect(ranked.map((r) => r.candidate.osmId)).toContain(11);
  });

  it('penalizes a far-off-route lot below a near one', () => {
    const nearLot = cand({ osmId: 20, lat: 45.62, lng: 4.72, category: 'parking' });
    // ~5 km north of the route corridor.
    const farLot = cand({ osmId: 21, lat: 45.67, lng: 4.72, category: 'parking' });
    const ranked = rankOvernightCandidates({
      candidates: [farLot, nearLot],
      anchor: ANCHOR,
      routePolyline: ROUTE,
    });
    expect(ranked[0].candidate.osmId).toBe(20);
    expect(ranked.find((r) => r.candidate.osmId === 21)!.detourKm).toBeGreaterThan(2);
  });

  it('rewards caravan sites and motorhome tags', () => {
    const plainLot = cand({ osmId: 30, lat: 45.62, lng: 4.72, category: 'parking' });
    const caravanSite = cand({
      osmId: 31,
      lat: 45.62,
      lng: 4.72,
      category: 'caravan_site',
      motorhomeFriendly: true,
    });
    const ranked = rankOvernightCandidates({
      candidates: [plainLot, caravanSite],
      anchor: ANCHOR,
      routePolyline: ROUTE,
    });
    expect(ranked[0].candidate.osmId).toBe(31);
  });
});
