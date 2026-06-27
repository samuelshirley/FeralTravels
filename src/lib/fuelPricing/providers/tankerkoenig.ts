/**
 * Tankerkönig (Germany) price provider — `bulk`, selection-grade.
 *
 * Germany's MTS-K mandates real-time fuel prices; Tankerkönig redistributes them
 * free (CC BY 4.0, registration for a key). We don't have Tankerkönig station
 * ids from OSM, so we query the radius `list` endpoint around clusters of our
 * candidate stations and match returned stations back by coordinates.
 *
 * Terms note: Tankerkönig forbids long-term storage of prices and requires
 * attribution. Prices here are treated as live (asOf = fetch time) and persisted
 * only briefly on the stop row alongside `price_as_of` for display — refreshed,
 * not archived.
 *
 * `fetchImpl` is injectable so the clustering + matching logic is unit-testable
 * without the network or a key.
 */

import { haversineKm } from '@/lib/polyline';
import { asArray, asNumber, asRecord } from '../parse';
import type { FuelPrice, FuelType, PriceProvider, PriceableStation } from '../types';

const TK_LIST_URL = 'https://creativecommons.tankerkoenig.de/json/list.php';
/** Match an OSM candidate to a returned Tankerkönig station within this radius. */
const MATCH_KM = 0.15;
/** Cluster candidates so each query's 25 km radius (API max) covers the group. */
const CLUSTER_RADIUS_KM = 20;
/** Map our coarse fuel type to a Tankerkönig price field. `petrol` → E5 (95). */
const TK_FIELD: Record<FuelType, 'diesel' | 'e5'> = { diesel: 'diesel', petrol: 'e5' };

export interface TkFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
export type TkFetch = (url: string) => Promise<TkFetchResponse>;

interface LatLng {
  lat: number;
  lng: number;
}

function centroid(points: LatLng[]): LatLng {
  const n = points.length || 1;
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / n,
    lng: points.reduce((s, p) => s + p.lng, 0) / n,
  };
}

/** Greedy clustering: each ungrouped station seeds a cluster of nearby ones. */
function clusterStations(
  stations: PriceableStation[],
  radiusKm: number
): PriceableStation[][] {
  const remaining = [...stations];
  const clusters: PriceableStation[][] = [];
  while (remaining.length > 0) {
    const seed = remaining.shift() as PriceableStation;
    const cluster = [seed];
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (haversineKm(seed, remaining[i]) <= radiusKm) {
        cluster.push(remaining[i]);
        remaining.splice(i, 1);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

export function createTankerkoenigProvider(
  apiKey: string,
  fetchImpl: TkFetch = globalThis.fetch as unknown as TkFetch
): PriceProvider {
  return {
    id: 'tankerkoenig',
    countries: new Set(['DE']),
    mode: 'bulk',
    async priceStations(
      stations: PriceableStation[],
      fuelType: FuelType
    ): Promise<Map<string, FuelPrice>> {
      const result = new Map<string, FuelPrice>();
      const field = TK_FIELD[fuelType];

      for (const cluster of clusterStations(stations, CLUSTER_RADIUS_KM)) {
        const c = centroid(cluster);
        const url =
          `${TK_LIST_URL}?lat=${c.lat.toFixed(5)}&lng=${c.lng.toFixed(5)}` +
          `&rad=25&sort=dist&type=all&apikey=${encodeURIComponent(apiKey)}`;

        let json: unknown;
        try {
          const res = await fetchImpl(url);
          if (!res.ok) continue;
          json = await res.json();
        } catch {
          continue;
        }

        const tkStations = asArray(asRecord(json)?.stations);
        for (const target of cluster) {
          if (result.has(target.id)) continue;
          let best: { km: number; price: number } | null = null;
          for (const raw of tkStations) {
            const tk = asRecord(raw);
            if (!tk) continue;
            const lat = asNumber(tk.lat);
            const lng = asNumber(tk.lng);
            const price = asNumber(tk[field]);
            if (lat == null || lng == null || price == null || price <= 0) continue;
            const km = haversineKm(
              { lat: target.lat, lng: target.lng },
              { lat, lng }
            );
            if (km <= MATCH_KM && (best == null || km < best.km)) {
              best = { km, price };
            }
          }
          if (best) {
            result.set(target.id, {
              amount: best.price,
              currency: 'EUR',
              fuelType,
              asOf: new Date().toISOString(),
              source: 'tankerkoenig',
            });
          }
        }
      }
      return result;
    },
  };
}
