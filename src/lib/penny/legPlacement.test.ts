import { describe, it, expect, vi } from 'vitest';

// `server-only` (pulled in via ./geo) throws under the jsdom test env; stub it
// (hoisted above imports) — same pattern as newLegFallback.test.ts.
vi.mock('server-only', () => ({}));

import { inferInsertAfterSort, type PlacementLeg } from './legPlacement';

function leg(sortOrder: number, endLat: number | null, endLng: number | null): PlacementLeg {
  return { sortOrder, endLat, endLng };
}

// Rough real-world coords from the 2026-06-29 incident trip.
const TRONDHEIM = { lat: 63.43037, lng: 10.39503 };
const BRONNOYSUND = { lat: 64.8638, lng: 11.8711 };
const GIRONA = { lat: 41.98311, lng: 2.82493 };

describe('inferInsertAfterSort', () => {
  const trip: PlacementLeg[] = [
    leg(0, TRONDHEIM.lat, TRONDHEIM.lng), // arrives Trondheim
    leg(1, TRONDHEIM.lat, TRONDHEIM.lng), // rest day at Trondheim
    leg(2, 65.78114, 13.28129), // → Mosjøen
    leg(3, GIRONA.lat, GIRONA.lng), // ... last leg ends Girona
  ];

  it('inserts a new leg after the LAST leg ending at its start point', () => {
    // "Trondheim → Brønnøysund" starts at Trondheim: after the rest day
    // (sort 1), not after the arriving drive (sort 0), and NOT at the end.
    expect(inferInsertAfterSort(trip, TRONDHEIM.lat, TRONDHEIM.lng)).toBe(1);
  });

  it('REGRESSION: a mid-route batch leg must not be appended after Girona', () => {
    // The incident: the first batch leg ("Trondheim → Brønnøysund") was
    // inserted correctly MID-trip via after_leg_id; the follow-up
    // "Brønnøysund → Mosjøen" carried no placement and was appended at max+1
    // — after Girona, the trip's final leg — and continuity repair then
    // manufactured a 3,383 km Girona → Mosjøen day. With inference it chains
    // after the just-inserted mid-trip leg ending at Brønnøysund.
    const withInserted: PlacementLeg[] = [
      leg(0, TRONDHEIM.lat, TRONDHEIM.lng),
      leg(1, TRONDHEIM.lat, TRONDHEIM.lng),
      leg(2, BRONNOYSUND.lat, BRONNOYSUND.lng), // just-inserted, mid-trip
      leg(3, 65.78114, 13.28129),
      leg(4, GIRONA.lat, GIRONA.lng), // trip still ends at Girona
    ];
    expect(inferInsertAfterSort(withInserted, BRONNOYSUND.lat, BRONNOYSUND.lng)).toBe(2);
  });

  it('returns null (plain append) when the match is already the last leg', () => {
    // Sequential trip building: each new leg starts where the current last
    // leg ends — appending is correct, no shift needed.
    expect(inferInsertAfterSort(trip, GIRONA.lat, GIRONA.lng)).toBeNull();
  });

  it('returns null when the start matches no existing endpoint', () => {
    expect(inferInsertAfterSort(trip, 48.8566, 2.3522)).toBeNull(); // Paris
  });

  it('returns null without start coords or without legs', () => {
    expect(inferInsertAfterSort(trip, null, null)).toBeNull();
    expect(inferInsertAfterSort([], TRONDHEIM.lat, TRONDHEIM.lng)).toBeNull();
  });

  it('ignores legs without end coords', () => {
    const legs = [leg(0, null, null), leg(1, TRONDHEIM.lat, TRONDHEIM.lng), leg(2, GIRONA.lat, GIRONA.lng)];
    expect(inferInsertAfterSort(legs, TRONDHEIM.lat, TRONDHEIM.lng)).toBe(1);
  });

  it('treats nearby (<50km) endpoints as the same place', () => {
    // Heimdal is ~8km from Trondheim center — same stop for placement.
    expect(inferInsertAfterSort(trip, 63.3543, 10.3624)).toBe(1);
  });
});
