/**
 * Which countries have a fuel-price source — decided statically so we can show
 * "price unavailable in {country}" without spending any lookups. See
 * docs/design/finn-fuel-agent.md → "Price availability model".
 */

/**
 * Countries with a per-station open feed (selection-grade — a `bulk` provider).
 * Germany is live (Tankerkönig). France/Spain/Italy use the same interface and
 * get added here as their adapters land.
 */
export const FEED_COUNTRIES: ReadonlySet<string> = new Set(['DE']);

/**
 * Countries with NO usable per-station price source — no open feed AND thin
 * Google `fuelOptions` coverage. We report `unavailable_in_country` here even
 * when a Google key is configured, rather than burn calls that return nothing.
 * The Nordics are the canonical case (the Sweden→Nordkapp trip).
 */
export const NO_PRICE_COUNTRIES: ReadonlySet<string> = new Set([
  'NO', // Norway
  'SE', // Sweden
  'FI', // Finland
  'DK', // Denmark
  'IS', // Iceland
]);

/**
 * True if *some* price source could price a station in this country.
 *
 * - Known feed country → yes.
 * - Known no-price country → no (even with Google configured).
 * - Unknown / other country → depends on whether a global provider (Google) is
 *   configured; that's our only hope there.
 */
export function countryHasAnyPriceSource(
  country: string | null | undefined,
  hasGlobalProvider: boolean
): boolean {
  if (country && FEED_COUNTRIES.has(country)) return true;
  if (country && NO_PRICE_COUNTRIES.has(country)) return false;
  return hasGlobalProvider;
}
