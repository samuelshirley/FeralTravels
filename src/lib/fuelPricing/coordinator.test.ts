import { describe, it, expect } from 'vitest';
import { resolveStationPrices } from './coordinator';
import type { FuelPrice, PriceProvider, PriceableStation } from './types';

const stn = (id: string, country: string | null): PriceableStation => ({
  id,
  lat: 50,
  lng: 8,
  country,
});

function fakeProvider(
  id: string,
  countries: ReadonlySet<string> | '*',
  mode: 'bulk' | 'per_station',
  priceMap: Record<string, number>
): PriceProvider {
  return {
    id,
    countries,
    mode,
    async priceStations(stations) {
      const out = new Map<string, FuelPrice>();
      for (const s of stations) {
        if (s.id in priceMap) {
          out.set(s.id, {
            amount: priceMap[s.id],
            currency: 'EUR',
            fuelType: 'diesel',
            asOf: '2026-06-27T00:00:00Z',
            source: id,
          });
        }
      }
      return out;
    },
  };
}

describe('resolveStationPrices', () => {
  it('prices what a provider returns; marks the rest unknown in covered countries', async () => {
    const providers = [fakeProvider('de', new Set(['DE']), 'bulk', { a: 1.7 })];
    const res = await resolveStationPrices([stn('a', 'DE'), stn('b', 'DE')], 'diesel', providers);
    expect(res.get('a')).toEqual({
      state: 'priced',
      price: expect.objectContaining({ amount: 1.7, source: 'de' }),
    });
    expect(res.get('b')).toEqual({ state: 'unknown' });
  });

  it('marks no-source countries unavailable_in_country (even with a global provider)', async () => {
    const providers = [fakeProvider('google', '*', 'per_station', {})];
    const res = await resolveStationPrices([stn('x', 'SE')], 'diesel', providers);
    expect(res.get('x')).toEqual({ state: 'unavailable_in_country', country: 'SE' });
  });

  it('lets a global provider price an otherwise-uncovered country', async () => {
    const providers = [fakeProvider('google', '*', 'per_station', { u: 3.2 })];
    const res = await resolveStationPrices([stn('u', 'US')], 'diesel', providers);
    expect(res.get('u')?.state).toBe('priced');
  });

  it('runs bulk providers before per-station ones', async () => {
    const bulk = fakeProvider('de', new Set(['DE']), 'bulk', { a: 1.5 });
    const perStation = fakeProvider('google', '*', 'per_station', { a: 9.9 });
    const res = await resolveStationPrices([stn('a', 'DE')], 'diesel', [perStation, bulk]);
    const r = res.get('a');
    expect(r?.state).toBe('priced');
    if (r?.state === 'priced') expect(r.price.source).toBe('de'); // bulk won
  });

  it('a throwing provider does not sink the rest', async () => {
    const boom: PriceProvider = {
      id: 'boom',
      countries: new Set(['DE']),
      mode: 'bulk',
      async priceStations() {
        throw new Error('feed down');
      },
    };
    const good = fakeProvider('google', '*', 'per_station', { a: 2.1 });
    const res = await resolveStationPrices([stn('a', 'DE')], 'diesel', [boom, good]);
    expect(res.get('a')?.state).toBe('priced');
  });
});
