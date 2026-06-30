import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { geocodePlace } from './geocode';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fake fetch that answers Text Search and Geocoding separately. */
function fakeFetch(byEndpoint: { text?: unknown; geo?: unknown }): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/place/textsearch/')) return jsonResponse(byEndpoint.text ?? { status: 'ZERO_RESULTS', results: [] });
    if (url.includes('/geocode/')) return jsonResponse(byEndpoint.geo ?? { status: 'ZERO_RESULTS', results: [] });
    return jsonResponse({ status: 'ZERO_RESULTS', results: [] });
  }) as unknown as typeof fetch;
}

const KEY = { apiKey: 'test-key' };

describe('geocodePlace', () => {
  it('resolves a specific business to a precise point', async () => {
    const fetchImpl = fakeFetch({
      text: {
        status: 'OK',
        results: [
          {
            name: 'Clean Kokos',
            formatted_address: 'Kong Oscars gate 45, Bergen, Norway',
            geometry: { location: { lat: 60.391, lng: 5.324 } },
            types: ['laundry', 'point_of_interest', 'establishment'],
            place_id: 'abc',
          },
        ],
      },
    });

    const result = await geocodePlace('Clean Kokos laundromat Bergen', { ...KEY, fetchImpl });
    expect(result).toMatchObject({
      status: 'resolved',
      match: { lat: 60.391, lng: 5.324, label: 'Clean Kokos', granularity: 'precise' },
    });
  });

  it('classifies a bare city as a locality centroid', async () => {
    const fetchImpl = fakeFetch({
      text: {
        status: 'OK',
        results: [
          {
            name: 'Bergen',
            formatted_address: 'Bergen, Norway',
            geometry: { location: { lat: 60.3913, lng: 5.3221 } },
            types: ['locality', 'political'],
          },
        ],
      },
    });

    const result = await geocodePlace('Bergen', { ...KEY, fetchImpl });
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.match.granularity).toBe('locality');
    }
  });

  it('flags ambiguity when two distinct precise places match', async () => {
    const fetchImpl = fakeFetch({
      text: {
        status: 'OK',
        results: [
          {
            name: 'Springfield Diner',
            formatted_address: 'Springfield, IL',
            geometry: { location: { lat: 39.78, lng: -89.65 } },
            types: ['restaurant', 'establishment'],
          },
          {
            name: 'Springfield Diner',
            formatted_address: 'Springfield, MO',
            geometry: { location: { lat: 37.21, lng: -93.29 } },
            types: ['restaurant', 'establishment'],
          },
        ],
      },
    });

    const result = await geocodePlace('Springfield Diner', { ...KEY, fetchImpl });
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('does NOT flag ambiguity for two same-named cities (centroid is fine)', async () => {
    const fetchImpl = fakeFetch({
      text: {
        status: 'OK',
        results: [
          {
            name: 'Bergen',
            formatted_address: 'Bergen, Norway',
            geometry: { location: { lat: 60.39, lng: 5.32 } },
            types: ['locality', 'political'],
          },
          {
            name: 'Bergen',
            formatted_address: 'Bergen, NJ, USA',
            geometry: { location: { lat: 40.92, lng: -74.03 } },
            types: ['locality', 'political'],
          },
        ],
      },
    });

    const result = await geocodePlace('Bergen', { ...KEY, fetchImpl });
    expect(result.status).toBe('resolved');
  });

  it('falls back to the Geocoding API when Text Search finds nothing', async () => {
    const fetchImpl = fakeFetch({
      text: { status: 'ZERO_RESULTS', results: [] },
      geo: {
        status: 'OK',
        results: [
          {
            formatted_address: '1600 Pennsylvania Ave NW, Washington, DC',
            geometry: { location: { lat: 38.8977, lng: -77.0365 }, location_type: 'ROOFTOP' },
            types: ['street_address'],
          },
        ],
      },
    });

    const result = await geocodePlace('1600 Pennsylvania Ave NW', { ...KEY, fetchImpl });
    expect(result).toMatchObject({ status: 'resolved', match: { granularity: 'precise' } });
  });

  it('returns not_found when both lookups are empty', async () => {
    const fetchImpl = fakeFetch({ text: { status: 'ZERO_RESULTS', results: [] }, geo: { status: 'ZERO_RESULTS', results: [] } });
    const result = await geocodePlace('asdkjfhaskjdfh nowhere', { ...KEY, fetchImpl });
    expect(result.status).toBe('not_found');
  });

  it('returns unavailable when the API rejects the key', async () => {
    const fetchImpl = fakeFetch({ text: { status: 'REQUEST_DENIED', error_message: 'API not enabled', results: [] } });
    const result = await geocodePlace('Bergen', { ...KEY, fetchImpl });
    expect(result.status).toBe('unavailable');
  });

  it('returns unavailable when no API key is configured', async () => {
    const prev = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    try {
      const result = await geocodePlace('Bergen', { fetchImpl: fakeFetch({}) });
      expect(result.status).toBe('unavailable');
    } finally {
      if (prev !== undefined) process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = prev;
    }
  });
});
