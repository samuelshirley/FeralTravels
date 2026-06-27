/**
 * Fuel pricing — shared types. The price layer is deliberately separate from
 * station-finding (OSM/Finn): a station's identity is durable and cached, but
 * its price is time-sensitive and region-specific. See
 * docs/design/finn-fuel-agent.md → "Price availability model".
 */

/**
 * The vehicle's fuel. Petrol grades (E5/E10/95/98) collapse to `petrol` for v1;
 * each provider maps `petrol` to its preferred grade (usually E5 / regular 95).
 */
export type FuelType = 'diesel' | 'petrol';

/** A resolved price for one station + fuel type. */
export interface FuelPrice {
  /** Price per litre, expressed in `currency`. */
  amount: number;
  /** ISO 4217, e.g. 'EUR', 'USD'. */
  currency: string;
  fuelType: FuelType;
  /** ISO timestamp the source last updated this price. */
  asOf: string;
  /** Provider id that produced it, e.g. 'tankerkoenig'. */
  source: string;
}

/**
 * Tri-state price outcome — NEVER a silent null:
 *  - `priced`                 — a provider returned a price.
 *  - `unknown`                — the country is covered, but this station has none.
 *  - `unavailable_in_country` — no pricing source covers this country at all.
 */
export type PriceResult =
  | { state: 'priced'; price: FuelPrice }
  | { state: 'unknown' }
  | { state: 'unavailable_in_country'; country: string };

/** Minimal station shape a provider needs to look up a price. */
export interface PriceableStation {
  /** Stable id (OSM `node/way` id) — the key results are returned under. */
  id: string;
  lat: number;
  lng: number;
  name?: string | null;
  brand?: string | null;
  /** ISO 3166-1 alpha-2 country, if known (from OSM `addr:country`). */
  country?: string | null;
}

/**
 * A regional price source behind one interface.
 *
 * `mode`:
 *  - `bulk`        — a feed that prices many stations in few calls (Tankerkönig
 *                    radius list). Cheap enough to run over *all* candidates, so
 *                    it can influence Finn's selection.
 *  - `per_station` — one call per station (Google `fuelOptions`). Used for
 *                    *display* on the chosen finalists, not bulk pre-selection.
 */
export interface PriceProvider {
  id: string;
  /** ISO country codes this provider can price, or '*' for global. */
  countries: ReadonlySet<string> | '*';
  mode: 'bulk' | 'per_station';
  /**
   * Resolve prices for the given stations + fuel type. Returns a map keyed by
   * `station.id` containing only the stations it could price. Must not throw for
   * a normal "no data" outcome — return a partial/empty map instead.
   */
  priceStations(
    stations: PriceableStation[],
    fuelType: FuelType
  ): Promise<Map<string, FuelPrice>>;
}

export function providerCovers(provider: PriceProvider, station: PriceableStation): boolean {
  if (provider.countries === '*') return true;
  return station.country != null && provider.countries.has(station.country);
}
