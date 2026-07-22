import { describe, it, expect } from 'vitest';
import { parsePlacesFuel, searchFuelAlongRoute, type FuelStation } from './places';

const sampleResponse = {
  places: [
    {
      id: 'PLACE_A',
      displayName: { text: 'Shell', languageCode: 'en' },
      location: { latitude: 59.33, longitude: 18.06 },
      types: ['gas_station', 'point_of_interest'],
      googleMapsUri: 'https://maps.google.com/?cid=A',
      businessStatus: 'OPERATIONAL',
    },
    {
      id: 'PLACE_B',
      displayName: { text: 'Circle K' },
      location: { latitude: 59.4, longitude: 18.1 },
      types: ['gas_station'],
    },
  ],
};

describe('parsePlacesFuel', () => {
  it('maps places to typed fuel stations', () => {
    const out = parsePlacesFuel(sampleResponse);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual<FuelStation>({
      placeId: 'PLACE_A',
      lat: 59.33,
      lng: 18.06,
      name: 'Shell',
      brand: null,
      types: ['gas_station', 'point_of_interest'],
      googleMapsUri: 'https://maps.google.com/?cid=A',
    });
  });

  it('keeps a place with no businessStatus (Google omits it when OK)', () => {
    const out = parsePlacesFuel(sampleResponse);
    expect(out.find((s) => s.placeId === 'PLACE_B')?.googleMapsUri).toBeNull();
  });

  it('drops permanently/temporarily closed forecourts', () => {
    const out = parsePlacesFuel({
      places: [
        { id: 'X', location: { latitude: 1, longitude: 2 }, businessStatus: 'CLOSED_PERMANENTLY' },
        { id: 'Y', location: { latitude: 1, longitude: 2 }, businessStatus: 'CLOSED_TEMPORARILY' },
      ],
    });
    expect(out).toHaveLength(0);
  });

  it('skips coordinate-less and id-less elements without throwing', () => {
    const out = parsePlacesFuel({
      places: [
        { id: 'ok', location: { latitude: 5, longitude: 6 } },
        { id: 'nocoords' },
        { location: { latitude: 1, longitude: 2 } },
        'garbage',
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].placeId).toBe('ok');
  });

  it('deduplicates by placeId', () => {
    const out = parsePlacesFuel({
      places: [
        { id: 'dup', location: { latitude: 1, longitude: 1 } },
        { id: 'dup', location: { latitude: 2, longitude: 2 } },
      ],
    });
    expect(out).toHaveLength(1);
  });

  it('returns [] for a response with no places key', () => {
    expect(parsePlacesFuel({})).toEqual([]);
    expect(parsePlacesFuel(null)).toEqual([]);
  });
});

describe('searchFuelAlongRoute', () => {
  const okFetch = (captured: { url?: string; init?: any }) => {
    return async (url: string, init?: any) => {
      captured.url = url;
      captured.init = init;
      return { ok: true, status: 200, text: async () => JSON.stringify(sampleResponse) };
    };
  };

  it('posts the encoded polyline with the Pro field mask and API key', async () => {
    const captured: { url?: string; init?: any } = {};
    const out = await searchFuelAlongRoute('abc_polyline', {
      fetchImpl: okFetch(captured),
      apiKey: 'TEST_KEY',
    });
    expect(out).toHaveLength(2);
    expect(captured.init.headers['X-Goog-Api-Key']).toBe('TEST_KEY');
    expect(captured.init.headers['X-Goog-FieldMask']).toContain('places.businessStatus');
    const body = JSON.parse(captured.init.body);
    expect(body.searchAlongRouteParameters.polyline.encodedPolyline).toBe('abc_polyline');
    expect(body.includedType).toBe('gas_station');
  });

  it('throws with no API key', async () => {
    await expect(
      searchFuelAlongRoute('abc', { fetchImpl: okFetch({}), apiKey: '' })
    ).rejects.toThrow(/API key/i);
  });

  it('throws on empty polyline', async () => {
    await expect(searchFuelAlongRoute('', { apiKey: 'K' })).rejects.toThrow(/empty/i);
  });

  it('throws on a non-OK HTTP status', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, text: async () => '' });
    await expect(
      searchFuelAlongRoute('abc', { fetchImpl, apiKey: 'K' })
    ).rejects.toThrow(/HTTP 429/);
  });

  it('throws on a non-JSON body', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<html>nope' });
    await expect(
      searchFuelAlongRoute('abc', { fetchImpl, apiKey: 'K' })
    ).rejects.toThrow(/non-JSON/);
  });
});
