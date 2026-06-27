import { describe, it, expect } from 'vitest';
import { createGoogleFuelOptionsProvider, type GoogleFetch } from './google';
import type { PriceableStation } from '../types';

const placesResponse = {
  places: [
    {
      location: { latitude: 40.0, longitude: -100.0 },
      fuelOptions: {
        fuelPrices: [
          {
            type: 'DIESEL',
            price: { currencyCode: 'USD', units: '4', nanos: 199000000 },
            updateTime: '2026-06-27T12:00:00Z',
          },
          {
            type: 'REGULAR_UNLEADED',
            price: { currencyCode: 'USD', units: '3', nanos: 499000000 },
            updateTime: '2026-06-27T12:00:00Z',
          },
        ],
      },
    },
  ],
};

function fakeFetch(body: unknown, ok = true): GoogleFetch {
  return async () => ({ ok, status: ok ? 200 : 500, json: async () => body });
}

const station: PriceableStation = { id: 'osm/9', lat: 40.0, lng: -100.0, country: 'US' };

describe('createGoogleFuelOptionsProvider', () => {
  it('parses a diesel fuelOptions price (units + nanos)', async () => {
    const p = createGoogleFuelOptionsProvider('key', fakeFetch(placesResponse));
    const res = await p.priceStations([station], 'diesel');
    const price = res.get('osm/9');
    expect(price?.amount).toBeCloseTo(4.199, 3);
    expect(price?.currency).toBe('USD');
    expect(price?.asOf).toBe('2026-06-27T12:00:00Z');
    expect(price?.source).toBe('google_fueloptions');
  });

  it('maps petrol to REGULAR_UNLEADED', async () => {
    const p = createGoogleFuelOptionsProvider('key', fakeFetch(placesResponse));
    const res = await p.priceStations([station], 'petrol');
    expect(res.get('osm/9')?.amount).toBeCloseTo(3.499, 3);
  });

  it('returns nothing when the station has no matching fuel price', async () => {
    const p = createGoogleFuelOptionsProvider(
      'key',
      fakeFetch({ places: [{ location: { latitude: 40, longitude: -100 }, fuelOptions: { fuelPrices: [] } }] })
    );
    const res = await p.priceStations([station], 'diesel');
    expect(res.size).toBe(0);
  });

  it('is global (covers any country)', () => {
    const p = createGoogleFuelOptionsProvider('key', fakeFetch(placesResponse));
    expect(p.countries).toBe('*');
    expect(p.mode).toBe('per_station');
  });
});
