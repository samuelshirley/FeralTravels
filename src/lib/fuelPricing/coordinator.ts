/**
 * Pricing coordinator — runs the configured providers over a set of stations and
 * returns a tri-state `PriceResult` for each. Pure orchestration: providers and
 * the "is a global provider available" flag are injected, so this is fully
 * unit-testable with fakes.
 *
 * Order: `bulk` providers first (cheap feeds, can price everything they cover),
 * then `per_station` providers (Google — one call each, used for finalists).
 * Anything still unpriced becomes `unknown` (covered country) or
 * `unavailable_in_country` (no source) per the static coverage map.
 */

import { countryHasAnyPriceSource } from './coverage';
import {
  providerCovers,
  type FuelPrice,
  type FuelType,
  type PriceProvider,
  type PriceResult,
  type PriceableStation,
} from './types';

export async function resolveStationPrices(
  stations: PriceableStation[],
  fuelType: FuelType,
  providers: PriceProvider[]
): Promise<Map<string, PriceResult>> {
  const priced = new Map<string, FuelPrice>();

  // Bulk feeds before per-station lookups.
  const ordered = [...providers].sort(
    (a, b) => (a.mode === 'bulk' ? 0 : 1) - (b.mode === 'bulk' ? 0 : 1)
  );

  for (const provider of ordered) {
    const targets = stations.filter(
      (s) => !priced.has(s.id) && providerCovers(provider, s)
    );
    if (targets.length === 0) continue;
    let got: Map<string, FuelPrice>;
    try {
      got = await provider.priceStations(targets, fuelType);
    } catch {
      // A provider failure must never sink pricing for everyone — skip it.
      got = new Map();
    }
    for (const [id, price] of got) {
      if (!priced.has(id)) priced.set(id, price);
    }
  }

  const hasGlobalProvider = providers.some((p) => p.countries === '*');

  const out = new Map<string, PriceResult>();
  for (const s of stations) {
    const price = priced.get(s.id);
    if (price) {
      out.set(s.id, { state: 'priced', price });
      continue;
    }
    out.set(
      s.id,
      countryHasAnyPriceSource(s.country, hasGlobalProvider)
        ? { state: 'unknown' }
        : { state: 'unavailable_in_country', country: s.country ?? 'this area' }
    );
  }
  return out;
}
