import { describe, it, expect } from 'vitest';
import { createTankerkoenigProvider, type TkFetch } from './tankerkoenig';
import type { PriceableStation } from '../types';

// A Tankerkönig `list` response with two stations.
const tkResponse = {
  ok: true,
  stations: [
    { id: '1', lat: 52.5200, lng: 13.4050, diesel: 1.62, e5: 1.78, e10: 1.72 },
    { id: '2', lat: 52.5300, lng: 13.4100, diesel: 1.59, e5: false, e10: 1.69 },
  ],
};

function fakeFetch(body: unknown, ok = true): TkFetch {
  return async () => ({ ok, status: ok ? 200 : 500, json: async () => body });
}

const station = (id: string, lat: number, lng: number): PriceableStation => ({
  id,
  lat,
  lng,
  country: 'DE',
});

describe('createTankerkoenigProvider', () => {
  it('matches an OSM candidate to a nearby feed station and prices diesel', async () => {
    const p = createTankerkoenigProvider('key', fakeFetch(tkResponse));
    // ~10 m from station id 1.
    const res = await p.priceStations([station('osm/1', 52.52001, 13.40501)], 'diesel');
    const price = res.get('osm/1');
    expect(price?.amount).toBe(1.62);
    expect(price?.currency).toBe('EUR');
    expect(price?.source).toBe('tankerkoenig');
  });

  it('maps petrol to the E5 grade', async () => {
    const p = createTankerkoenigProvider('key', fakeFetch(tkResponse));
    const res = await p.priceStations([station('osm/1', 52.52001, 13.40501)], 'petrol');
    expect(res.get('osm/1')?.amount).toBe(1.78);
  });

  it('skips a station whose grade price is missing (e5=false)', async () => {
    const p = createTankerkoenigProvider('key', fakeFetch(tkResponse));
    // Near station id 2, which has e5=false.
    const res = await p.priceStations([station('osm/2', 52.53001, 13.41001)], 'petrol');
    expect(res.has('osm/2')).toBe(false);
  });

  it('does not match a candidate that is far from any feed station', async () => {
    const p = createTankerkoenigProvider('key', fakeFetch(tkResponse));
    const res = await p.priceStations([station('osm/far', 48.0, 11.0)], 'diesel');
    expect(res.size).toBe(0);
  });

  it('returns empty (not throwing) on a failed request', async () => {
    const p = createTankerkoenigProvider('key', fakeFetch({}, false));
    const res = await p.priceStations([station('osm/1', 52.52001, 13.40501)], 'diesel');
    expect(res.size).toBe(0);
  });
});
