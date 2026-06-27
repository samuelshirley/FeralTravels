/**
 * Google Places `fuelOptions` price provider — `per_station`, global fallback.
 *
 * Places API (New) returns `fuelOptions.fuelPrices[]` (type, price, updateTime)
 * for many gas stations. It's our price source where no open feed covers the
 * region (notably the US). It's `per_station` (one Nearby call each), so the
 * coordinator only runs it on the chosen finalists — never bulk pre-selection.
 *
 * Legal: Google place data must NOT be persisted long-term — prices fetched here
 * are live/throwaway, shown with `asOf` and refreshed, consistent with the
 * data-source split in docs/design/finn-fuel-agent.md.
 *
 * `fetchImpl` is injectable so parsing is unit-testable without a key/network.
 */

import { haversineKm } from '@/lib/polyline';
import { asArray, asNumber, asRecord, asString } from '../parse';
import type { FuelPrice, FuelType, PriceProvider, PriceableStation } from '../types';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const SEARCH_RADIUS_M = 1500;
/** Map our coarse fuel type to a Google `FuelPrice.type` enum value. */
const GOOGLE_FUEL_TYPE: Record<FuelType, string> = {
  diesel: 'DIESEL',
  petrol: 'REGULAR_UNLEADED',
};

export interface GoogleFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
export type GoogleFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<GoogleFetchResponse>;

/** Parse a Google `Money` ({units, nanos, currencyCode}) into a number. */
function parseMoney(money: Record<string, unknown>): { amount: number; currency: string } | null {
  const units = asNumber(money.units) ?? 0;
  const nanos = asNumber(money.nanos) ?? 0;
  const amount = units + nanos / 1e9;
  if (!(amount > 0)) return null;
  return { amount, currency: asString(money.currencyCode) ?? 'USD' };
}

export function createGoogleFuelOptionsProvider(
  apiKey: string,
  fetchImpl: GoogleFetch = globalThis.fetch as unknown as GoogleFetch
): PriceProvider {
  return {
    id: 'google_fueloptions',
    countries: '*',
    mode: 'per_station',
    async priceStations(
      stations: PriceableStation[],
      fuelType: FuelType
    ): Promise<Map<string, FuelPrice>> {
      const result = new Map<string, FuelPrice>();
      const wantedType = GOOGLE_FUEL_TYPE[fuelType];

      for (const s of stations) {
        try {
          const res = await fetchImpl(SEARCH_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': 'places.location,places.fuelOptions',
            },
            body: JSON.stringify({
              includedTypes: ['gas_station'],
              maxResultCount: 5,
              locationRestriction: {
                circle: {
                  center: { latitude: s.lat, longitude: s.lng },
                  radius: SEARCH_RADIUS_M,
                },
              },
            }),
          });
          if (!res.ok) continue;
          const data = asRecord(await res.json());
          const places = asArray(data?.places);

          let best: { km: number; price: FuelPrice } | null = null;
          for (const raw of places) {
            const place = asRecord(raw);
            const loc = asRecord(place?.location);
            const lat = asNumber(loc?.latitude);
            const lng = asNumber(loc?.longitude);
            if (lat == null || lng == null) continue;

            const fuelPrices = asArray(asRecord(place?.fuelOptions)?.fuelPrices);
            const matchRaw = fuelPrices.find((fp) => asRecord(fp)?.type === wantedType);
            const match = asRecord(matchRaw);
            const money = asRecord(match?.price);
            if (!money) continue;
            const parsed = parseMoney(money);
            if (!parsed) continue;

            const km = haversineKm({ lat: s.lat, lng: s.lng }, { lat, lng });
            if (best == null || km < best.km) {
              best = {
                km,
                price: {
                  amount: parsed.amount,
                  currency: parsed.currency,
                  fuelType,
                  asOf: asString(match?.updateTime) ?? new Date().toISOString(),
                  source: 'google_fueloptions',
                },
              };
            }
          }
          if (best) result.set(s.id, best.price);
        } catch {
          // Skip this station; never sink the batch.
        }
      }
      return result;
    },
  };
}
