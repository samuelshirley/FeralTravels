/**
 * Tests for the Overpass query builder and response parser. No live network —
 * the parser runs against a fixture and the fetch is exercised with an
 * injected fake fetch.
 */
import { describe, it, expect, vi } from 'vitest';

// `server-only` throws under the jsdom test env; stub it (hoisted above imports).
vi.mock('server-only', () => ({}));

import {
  buildOverpassQuery,
  parseOverpassResponse,
  fetchOverpass,
  OVERNIGHT_OSM_SELECTORS,
} from './overpass';
import type { BBox } from './anchor';

const BBOX: BBox = { south: 45.6, west: 4.7, north: 45.7, east: 4.8 };

describe('buildOverpassQuery', () => {
  it('embeds the bbox and every selector', () => {
    const q = buildOverpassQuery(BBOX);
    expect(q).toContain('[out:json]');
    expect(q).toContain('45.6,4.7,45.7,4.8');
    for (const [k, v] of OVERNIGHT_OSM_SELECTORS) {
      expect(q).toContain(`nwr["${k}"="${v}"]`);
    }
    expect(q).toContain('out center tags;');
  });
});

describe('parseOverpassResponse', () => {
  const fixture = {
    elements: [
      // node parking lot
      { type: 'node', id: 1, lat: 45.61, lon: 4.71, tags: { amenity: 'parking', surface: 'gravel' } },
      // way park with a center
      { type: 'way', id: 2, center: { lat: 45.62, lon: 4.72 }, tags: { leisure: 'park', name: 'Parc' } },
      // dog park node
      { type: 'node', id: 3, lat: 45.63, lon: 4.73, tags: { leisure: 'dog_park' } },
      // caravan site with motorhome tag
      { type: 'way', id: 4, center: { lat: 45.64, lon: 4.74 }, tags: { tourism: 'caravan_site', motorhome: 'yes' } },
      // fuel
      { type: 'node', id: 5, lat: 45.65, lon: 4.75, tags: { amenity: 'fuel' } },
      // element with no coords → skipped
      { type: 'relation', id: 6, tags: { leisure: 'park' } },
      // unrelated element → skipped
      { type: 'node', id: 7, lat: 45.66, lon: 4.76, tags: { shop: 'bakery' } },
    ],
  };

  it('maps elements to typed candidates, deriving coords from center', () => {
    const out = parseOverpassResponse(fixture);
    const byId = new Map(out.map((c) => [c.osmId, c]));

    expect(out).toHaveLength(5); // ids 1–5; 6 (no coords) and 7 (unrelated) dropped

    expect(byId.get(1)?.category).toBe('parking');
    expect(byId.get(1)?.surface).toBe('gravel');

    expect(byId.get(2)?.category).toBe('park');
    expect(byId.get(2)?.lat).toBe(45.62);
    expect(byId.get(2)?.lng).toBe(4.72);
    expect(byId.get(2)?.name).toBe('Parc');

    expect(byId.get(3)?.category).toBe('dog_park');

    expect(byId.get(4)?.category).toBe('caravan_site');
    expect(byId.get(4)?.motorhomeFriendly).toBe(true);

    expect(byId.get(5)?.category).toBe('fuel');
  });

  it('rejects malformed payloads', () => {
    expect(() => parseOverpassResponse({ nope: true })).toThrow();
  });
});

describe('fetchOverpass', () => {
  it('POSTs the query form-encoded and returns parsed JSON', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ elements: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    const result = await fetchOverpass('test-query', {
      fetchImpl: fakeFetch,
      endpoint: 'https://example.test/api',
    });
    expect(result).toEqual({ elements: [] });
    expect(fakeFetch).toHaveBeenCalledOnce();
    const [, init] = (fakeFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toContain('data=');
    expect(init.body).toContain(encodeURIComponent('test-query'));
  });

  it('throws on a non-OK response rather than swallowing it', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' })
    ) as unknown as typeof fetch;

    await expect(
      fetchOverpass('q', { fetchImpl: fakeFetch })
    ).rejects.toThrow(/429/);
  });
});
