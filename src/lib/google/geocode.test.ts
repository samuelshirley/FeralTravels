import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { geocodePlace } from './geocode';

/** One place in the Places API (New) searchText response shape. */
interface PlaceLite {
  location: { latitude: number; longitude: number };
  displayName?: { text: string };
  formattedAddress?: string;
  types?: string[];
  id?: string;
}

/** Fake fetch that returns a Places (New) searchText payload. */
function okFetch(places: PlaceLite[]): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ places }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  ) as unknown as typeof fetch;
}

const KEY = { apiKey: 'test-key' };

describe('geocodePlace', () => {
  it('resolves a specific business to a precise point', async () => {
    const fetchImpl = okFetch([
      {
        location: { latitude: 60.391, longitude: 5.324 },
        displayName: { text: 'Clean Kokos' },
        formattedAddress: 'Kong Oscars gate 45, Bergen, Norway',
        types: ['laundry', 'point_of_interest', 'establishment'],
        id: 'abc',
      },
    ]);

    const result = await geocodePlace('Clean Kokos laundromat Bergen', { ...KEY, fetchImpl });
    expect(result).toMatchObject({
      status: 'resolved',
      match: { lat: 60.391, lng: 5.324, label: 'Clean Kokos', granularity: 'precise' },
    });
  });

  it('classifies a bare city as a locality centroid', async () => {
    const fetchImpl = okFetch([
      {
        location: { latitude: 60.3913, longitude: 5.3221 },
        displayName: { text: 'Bergen' },
        formattedAddress: 'Bergen, Norway',
        types: ['locality', 'political'],
      },
    ]);

    const result = await geocodePlace('Bergen', { ...KEY, fetchImpl });
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.match.granularity).toBe('locality');
    }
  });

  it('flags ambiguity when two distinct precise places match', async () => {
    const fetchImpl = okFetch([
      {
        location: { latitude: 39.78, longitude: -89.65 },
        displayName: { text: 'Springfield Diner' },
        formattedAddress: 'Springfield, IL',
        types: ['restaurant', 'establishment'],
      },
      {
        location: { latitude: 37.21, longitude: -93.29 },
        displayName: { text: 'Springfield Diner' },
        formattedAddress: 'Springfield, MO',
        types: ['restaurant', 'establishment'],
      },
    ]);

    const result = await geocodePlace('Springfield Diner', { ...KEY, fetchImpl });
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('does NOT flag ambiguity for two same-named cities (centroid is fine)', async () => {
    const fetchImpl = okFetch([
      {
        location: { latitude: 60.39, longitude: 5.32 },
        displayName: { text: 'Bergen' },
        formattedAddress: 'Bergen, Norway',
        types: ['locality', 'political'],
      },
      {
        location: { latitude: 40.92, longitude: -74.03 },
        displayName: { text: 'Bergen' },
        formattedAddress: 'Bergen, NJ, USA',
        types: ['locality', 'political'],
      },
    ]);

    const result = await geocodePlace('Bergen', { ...KEY, fetchImpl });
    expect(result.status).toBe('resolved');
  });

  it('calls the Places API (New) searchText endpoint — never the legacy one', async () => {
    let capturedUrl = '';
    let capturedInit: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = (init ?? {}) as Record<string, unknown>;
      return new Response(JSON.stringify({ places: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await geocodePlace('Bergen', { ...KEY, fetchImpl });

    expect(capturedUrl).toContain('places.googleapis.com/v1/places:searchText');
    // Guard against a regression back to the deprecated Places API endpoint.
    expect(capturedUrl).not.toContain('/place/textsearch/');
    const headers = capturedInit.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('test-key');
    expect(headers['X-Goog-FieldMask']).toContain('places.location');
    expect(capturedInit.method).toBe('POST');
    expect(String(capturedInit.body)).toContain('Bergen');
  });

  it('returns not_found when the search is empty', async () => {
    const result = await geocodePlace('asdkjfhaskjdfh nowhere', { ...KEY, fetchImpl: okFetch([]) });
    expect(result.status).toBe('not_found');
  });

  it('returns unavailable when the API rejects the key', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'API not enabled' } }),
          { status: 403 }
        )
    ) as unknown as typeof fetch;

    const result = await geocodePlace('Bergen', { ...KEY, fetchImpl });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toContain('API not enabled');
    }
  });

  it('returns unavailable on a network/transport failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const result = await geocodePlace('Bergen', { ...KEY, fetchImpl });
    expect(result.status).toBe('unavailable');
  });

  it('returns unavailable when no API key is configured', async () => {
    const prev = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    try {
      const result = await geocodePlace('Bergen', { fetchImpl: okFetch([]) });
      expect(result.status).toBe('unavailable');
    } finally {
      if (prev !== undefined) process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = prev;
    }
  });
});
