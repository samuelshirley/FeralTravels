import { describe, it, expect } from 'vitest';
import {
  buildFuelCorridorQuery,
  downsampleByDistanceKm,
  parseOverpassFuel,
  fetchFuelCorridor,
  type OsmFuelStation,
} from './overpass';
import type { LatLng } from '@/lib/polyline';

// A short synthetic route heading roughly east at ~51°N. ~0.0143° lng ≈ 1 km here.
const route: LatLng[] = [
  { lat: 51.0, lng: 7.0 },
  { lat: 51.0, lng: 7.2 },
  { lat: 51.0, lng: 7.4 },
  { lat: 51.0, lng: 7.6 },
];

describe('downsampleByDistanceKm', () => {
  it('always keeps first and last vertices', () => {
    const out = downsampleByDistanceKm(route, 1000);
    expect(out[0]).toEqual(route[0]);
    expect(out[out.length - 1]).toEqual(route[route.length - 1]);
  });

  it('thins a dense polyline when step is large', () => {
    const out = downsampleByDistanceKm(route, 1000); // 1000 km step → only endpoints
    expect(out.length).toBe(2);
  });

  it('handles degenerate input', () => {
    expect(downsampleByDistanceKm([], 5)).toEqual([]);
    expect(downsampleByDistanceKm([route[0]], 5)).toEqual([route[0]]);
  });
});

describe('buildFuelCorridorQuery', () => {
  it('embeds both fuel filters and an around clause', () => {
    const { query } = buildFuelCorridorQuery(route, { bufferMeters: 1500 });
    expect(query).toContain('["amenity"="fuel"]');
    expect(query).toContain('["highway"="services"]');
    expect(query).toContain('around:');
    expect(query).toContain('out center tags;');
    expect(query).toContain('[out:json]');
  });

  it('caps embedded coordinates at maxCoords', () => {
    const dense: LatLng[] = Array.from({ length: 500 }, (_, i) => ({
      lat: 51,
      lng: 7 + i * 0.01,
    }));
    const { coordCount } = buildFuelCorridorQuery(dense, { maxCoords: 50 });
    expect(coordCount).toBeLessThanOrEqual(51); // maxCoords + the forced final vertex
  });

  it('widens the effective buffer to keep the corridor contiguous', () => {
    // Long route + few coords → large spacing → buffer must widen past the ask.
    const long: LatLng[] = [
      { lat: 51, lng: 7 },
      { lat: 51, lng: 12 }, // ~350 km
    ];
    const { effectiveBufferMeters } = buildFuelCorridorQuery(long, {
      bufferMeters: 2000,
      maxCoords: 2,
    });
    expect(effectiveBufferMeters).toBeGreaterThan(2000);
  });

  it('throws on too-short input', () => {
    expect(() => buildFuelCorridorQuery([route[0]])).toThrow();
  });
});

describe('parseOverpassFuel', () => {
  const fixture = {
    elements: [
      // plain fuel node
      {
        type: 'node',
        id: 1,
        lat: 51.001,
        lon: 7.05,
        tags: { amenity: 'fuel', name: 'Aral', brand: 'Aral', 'fuel:diesel': 'yes' },
      },
      // fuel mapped as a way → coords come from center
      {
        type: 'way',
        id: 2,
        center: { lat: 51.002, lon: 7.15 },
        tags: { amenity: 'fuel', name: 'Shell' },
      },
      // motorway service area
      {
        type: 'way',
        id: 3,
        center: { lat: 51.0, lon: 7.3 },
        tags: { highway: 'services', name: 'Rasthof Ost' },
      },
      // not fuel, not services → skipped
      {
        type: 'node',
        id: 4,
        lat: 51.0,
        lon: 7.31,
        tags: { amenity: 'restaurant', name: 'Not fuel' },
      },
      // coordinate-less → skipped
      { type: 'way', id: 5, tags: { amenity: 'fuel' } },
      // duplicate of id 1 (identical, as Overpass would return) → deduped
      {
        type: 'node',
        id: 1,
        lat: 51.001,
        lon: 7.05,
        tags: { amenity: 'fuel', name: 'Aral', brand: 'Aral', 'fuel:diesel': 'yes' },
      },
    ],
  };

  it('parses nodes, ways (via center), and service areas; skips junk; dedupes', () => {
    const out = parseOverpassFuel(fixture);
    const ids = out.map((s) => s.osmId).sort();
    expect(ids).toEqual(['node/1', 'way/2', 'way/3']);
  });

  it('flags motorway service areas', () => {
    const out = parseOverpassFuel(fixture);
    const services = out.find((s) => s.osmId === 'way/3') as OsmFuelStation;
    expect(services.isMotorwayServices).toBe(true);
    const station = out.find((s) => s.osmId === 'node/1') as OsmFuelStation;
    expect(station.isMotorwayServices).toBe(false);
  });

  it('keeps name, brand, and raw tags', () => {
    const out = parseOverpassFuel(fixture);
    const aral = out.find((s) => s.osmId === 'node/1') as OsmFuelStation;
    expect(aral.name).toBe('Aral');
    expect(aral.brand).toBe('Aral');
    expect(aral.tags['fuel:diesel']).toBe('yes');
    const shell = out.find((s) => s.osmId === 'way/2') as OsmFuelStation;
    expect(shell.brand).toBeNull();
  });

  it('returns [] for malformed roots', () => {
    expect(parseOverpassFuel(null)).toEqual([]);
    expect(parseOverpassFuel({})).toEqual([]);
    expect(parseOverpassFuel({ elements: 'nope' })).toEqual([]);
  });
});

describe('fetchFuelCorridor', () => {
  it('posts the query and parses the response via injected fetch', async () => {
    let capturedBody = '';
    const out = await fetchFuelCorridor(
      route,
      { bufferMeters: 1500 },
      {
        fetchImpl: async (_url, init) => {
          capturedBody = init?.body ?? '';
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                elements: [
                  { type: 'node', id: 9, lat: 51, lon: 7.1, tags: { amenity: 'fuel' } },
                ],
              }),
          };
        },
      }
    );
    expect(capturedBody).toContain('data=');
    expect(out).toHaveLength(1);
    expect(out[0].osmId).toBe('node/9');
  });

  it('throws on a non-200 response', async () => {
    await expect(
      fetchFuelCorridor(route, undefined, {
        fetchImpl: async () => ({ ok: false, status: 504, text: async () => '' }),
      })
    ).rejects.toThrow(/HTTP 504/);
  });

  it('throws on non-JSON', async () => {
    await expect(
      fetchFuelCorridor(route, undefined, {
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>' }),
      })
    ).rejects.toThrow(/non-JSON/);
  });
});
