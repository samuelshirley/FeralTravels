import 'server-only';

import { getDirections, type DirectionsOptions, type DirectionsResponse } from '@/lib/google/directions';
import { geocodePlace, type GeocodeOptions, type GeocodeResult } from '@/lib/google/geocode';
import { searchFuelAlongRoute, type FuelStation, type SearchAlongRouteDeps } from '@/lib/google/places';
import { logGoogleApiUsage, logGooglePlacesUsage } from '@/server/repos/usage';

/**
 * The ONLY way server code calls a paid Google API.
 *
 * WHY A BOUNDED MODULE, like `src/server/payments/`. On 2026-09-09 there were
 * eleven call sites of Directions / Places / Geocoding across routes, repos and
 * the Penny loop, and essentially none of them wrote a `usage_events` row —
 * `logGooglePlacesUsage` had had no caller since 2026-06-29 and the other two
 * APIs never had one. So the app's entire Google spend was invisible, at the
 * same time as CLAUDE.md was claiming those calls were free and an assistant
 * was building a fuel cascade on that belief.
 *
 * Asking every call site to remember a log line is the design that already
 * failed. Instead the accounting lives with the call, and
 * `googleAccountingGuard.test.ts` forbids importing the raw clients anywhere
 * outside this file.
 *
 * ACCOUNTING RULES, both learned the expensive way:
 *   - a FAILED call is billed exactly like a successful one, so the error path
 *     logs too (with `success: false`, which also puts it in /admin/errors);
 *   - logging must never be able to fail the operation it is measuring, so
 *     every write is caught and dropped to the console.
 *
 * `who` is best-effort. A repo-level re-route knows the trip but not always the
 * user, and a row with a null `user_id` still counts against the bill.
 */
export interface CallerRef {
  userId?: string | null;
  tripId?: string | null;
}

/** Fire-and-forget: accounting must not be able to break the thing it measures. */
function record(p: Promise<unknown>, what: string): void {
  void p.catch((e) => console.error(`[google-accounting] failed to log ${what}:`, e));
}

/** Google Directions, counted. */
export async function getDirectionsAccounted(
  origin: Parameters<typeof getDirections>[0],
  destination: Parameters<typeof getDirections>[1],
  options: DirectionsOptions = {},
  who: CallerRef = {},
): Promise<DirectionsResponse> {
  try {
    const res = await getDirections(origin, destination, options);
    record(
      logGoogleApiUsage({
        provider: 'google-directions',
        ...who,
        success: res.ok,
        errorMessage: res.ok ? null : `${res.kind}: ${res.message}`,
      }),
      'directions',
    );
    return res;
  } catch (err) {
    // getDirections resolves rather than throws today, but a future edit that
    // makes it throw must not silently stop the meter.
    record(
      logGoogleApiUsage({
        provider: 'google-directions',
        ...who,
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      }),
      'directions (threw)',
    );
    throw err;
  }
}

/** Places (New) Text Search along a route — Finn's station source, counted. */
export async function searchFuelAlongRouteAccounted(
  encodedPolyline: string,
  who: CallerRef = {},
  deps?: SearchAlongRouteDeps,
): Promise<FuelStation[]> {
  try {
    const stations = await searchFuelAlongRoute(encodedPolyline, deps);
    record(
      logGooglePlacesUsage({
        userId: who.userId ?? '',
        tripId: who.tripId ?? null,
        endpoint: 'text-search',
        requests: 1,
      }),
      'places text-search',
    );
    return stations;
  } catch (err) {
    record(
      logGooglePlacesUsage({
        userId: who.userId ?? '',
        tripId: who.tripId ?? null,
        endpoint: 'text-search',
        requests: 1,
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      }),
      'places text-search (failed)',
    );
    throw err;
  }
}

/** Places (New) Text Search for name→coords, counted. */
export async function geocodePlaceAccounted(
  query: string,
  opts: GeocodeOptions = {},
  who: CallerRef = {},
): Promise<GeocodeResult> {
  const res = await geocodePlace(query, opts);
  // `unavailable` with no key never reached Google, so it costs nothing and is
  // not counted — counting it would inflate the only number here anyone trusts.
  const reached = !(res.status === 'unavailable' && /no google maps api key/i.test(res.reason));
  if (reached) {
    record(
      logGoogleApiUsage({
        provider: 'google-geocode',
        ...who,
        success: res.status === 'resolved' || res.status === 'ambiguous',
        errorMessage: res.status === 'unavailable' ? res.reason : null,
      }),
      'geocode',
    );
  }
  return res;
}
