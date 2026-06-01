import 'server-only';
import { haversineKm, type LatLng } from '@/lib/polyline';

/**
 * Google Places gas-station lookup with adaptive radius escalation.
 *
 * Split out of `server/fuel.ts` so the Places adapter — pure HTTP + ranking,
 * no DB or auth — can be unit-tested in isolation (see `fuel.test.ts`).
 * `fuel.ts` owns the leg/trip orchestration and calls `findTopGasStations`.
 */

// ---------------------------------------------------------------------------
// Radius ladder
//
// Google Places Nearby Search radius, meters. Big enough to find a station in a
// rural stretch, small enough to stay on-route (a 10km detour feels acceptable
// on a long drive). First element of the escalation ladder below.
const SEARCH_RADIUS_KM = 10;
// Adaptive radius escalation. When Places returns zero gas_station results at
// one radius, retry at the next larger one before giving up. Urban/suburban
// legs resolve at 10 km (status quo, no extra cost); rural US / European
// A-roads / most Aus/Canadian highways resolve by 25-100 km; genuinely sparse
// regions (Norway, the Australian outback, Patagonia, Trans-Sahara) resolve at
// 500 km or trigger a user-visible warning. Worst case is 4 "essentials" Places
// calls (~$0.02) for one truly remote sample — bounded and cheap. Deterministic
// by design: same route + same Places data always escalates the same way.
export const PLACES_RADIUS_ESCALATION_KM = [SEARCH_RADIUS_KM, 25, 100, 500] as const;

// ---------------------------------------------------------------------------
// Google Places Nearby Search — v1 (Place Search (New)).
//
// We pick v1 over legacy because legacy Nearby Search has been tagged for
// retirement and the new endpoint's `includedTypes` filter is far tighter
// ("gas_station" only) than legacy's `type=gas_station` which leaks car
// dealers and mechanics.
// https://developers.google.com/maps/documentation/places/web-service/nearby-search

interface GasStation {
  name: string;
  lat: number;
  lng: number;
  place_id: string | null;
}

/** Up to 3 ranked candidates for one knot: the primary + up to 2 alternates. */
export interface GasStationRanked extends GasStation {
  /** Haversine km from the knot center — proxy for off-route detour. */
  distance_km: number;
}

export interface GasStationCandidates {
  primary: GasStationRanked;
  alternates: GasStationRanked[]; // 0..2 entries
}

/** Maximum total candidates returned per knot (1 primary + 2 alternates). */
const FUEL_CANDIDATES_PER_KNOT = 3;

const PLACES_RETRYABLE_HTTP = new Set([429, 502, 503]);
const PLACES_MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Unwrap a Places HTTP error to a string for logs and the leg error column. */
function placesErrorReason(httpStatus: number, body: string): string {
  if (httpStatus === 403) {
    if (body.includes('PERMISSION_DENIED') || body.includes('blocked')) {
      return (
        'Places API (New) returned 403 PERMISSION_DENIED — enable it (and billing) in Google Cloud Console. ' +
        'If this key is restricted to HTTP referrers, set GOOGLE_MAPS_SERVER_API_KEY to a separate key without referrer restrictions for server-side Places calls.'
      );
    }
    return (
      'Places API returned 403 — key restrictions are blocking the server. ' +
      'Use GOOGLE_MAPS_SERVER_API_KEY without HTTP referrer restrictions for Places REST calls from Vercel.'
    );
  }
  if (httpStatus === 400) {
    return `Places API returned 400 — "Places API (New)" may not be enabled for this project in Google Cloud Console.`;
  }
  return `Places API returned HTTP ${httpStatus}: ${body.slice(0, 120)}`;
}

export type FindGasOutcome =
  | { ok: true; data: GasStationCandidates | null; exhausted: boolean; callsMade: number }
  | { ok: false; message: string; callsMade: number };

/** Result of a single-radius Places lookup; `data: null` means "empty here". */
type RadiusOutcome =
  | { ok: true; data: GasStationCandidates | null }
  | { ok: false; message: string };

/**
 * Adaptive-radius fuel-station lookup. Walks `radiiKm` from tightest to widest,
 * returning the first radius that yields a station. If every radius comes back
 * empty, returns `data: null, exhausted: true` so the caller can flag the leg
 * `no_stations_found` instead of silently writing zero stops (the original bug:
 * one 10 km lookup over remote West Texas returned empty and the leg looked
 * "ready" with no stops and no warning). A hard Places error (auth, network)
 * short-circuits immediately — escalating the radius wouldn't fix a 403.
 *
 * `callsMade` lets the caller keep its Places usage tally accurate, since one
 * call to this function can hit the API up to `radiiKm.length` times.
 */
export async function findTopGasStations(
  center: LatLng,
  // Vehicle-level fuel type was dropped in 0007; signature kept as `null`
  // so the future fuel-type bias work has an obvious place to plug back in.
  fuelType: null,
  apiKey: string,
  radiiKm: readonly number[] = PLACES_RADIUS_ESCALATION_KM
): Promise<FindGasOutcome> {
  void fuelType;
  let callsMade = 0;
  for (const radiusKm of radiiKm) {
    const outcome = await searchGasStationsAtRadius(center, apiKey, radiusKm);
    callsMade += 1;
    if (!outcome.ok) {
      return { ok: false, message: outcome.message, callsMade };
    }
    if (outcome.data) {
      return { ok: true, data: outcome.data, exhausted: false, callsMade };
    }
    // Empty at this radius — widen and try again.
  }
  // Tried every radius, found nothing anywhere.
  return { ok: true, data: null, exhausted: true, callsMade };
}

/**
 * One Google Places Nearby Search at a fixed radius, with the existing
 * transient-HTTP retry loop. Returns `data: null` for a clean-but-empty result
 * so the escalation layer above can decide whether to widen.
 */
export async function searchGasStationsAtRadius(
  center: LatLng,
  apiKey: string,
  radiusKm: number
): Promise<RadiusOutcome> {
  const payload = () =>
    JSON.stringify({
      includedTypes: ['gas_station'],
      maxResultCount: 8,
      locationRestriction: {
        circle: {
          center: { latitude: center.lat, longitude: center.lng },
          radius: radiusKm * 1000,
        },
      },
    });

  let lastHttpMessage = 'Places nearby search failed.';

  for (let attempt = 0; attempt < PLACES_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask':
            'places.displayName,places.location,places.id,places.primaryType',
        },
        body: payload(),
      });

      const bodyText = await res.text().catch(() => '');

      if (!res.ok) {
        lastHttpMessage = placesErrorReason(res.status, bodyText);
        if (PLACES_RETRYABLE_HTTP.has(res.status) && attempt < PLACES_MAX_ATTEMPTS - 1) {
          await sleep(350 * (attempt + 1));
          continue;
        }
        console.error(`[fuel] Places API error: HTTP ${res.status} — ${lastHttpMessage}`);
        return { ok: false, message: lastHttpMessage };
      }

      const data = JSON.parse(bodyText) as {
        places?: Array<{
          id?: string;
          displayName?: { text?: string };
          location?: { latitude: number; longitude: number };
          primaryType?: string;
        }>;
      };
      const places = data.places ?? [];
      if (places.length === 0) return { ok: true, data: null };

      const ranked = places
        .map((p) => {
          const loc = p.location;
          if (!loc) return null;
          return {
            name: p.displayName?.text?.trim() || 'Gas station',
            lat: loc.latitude,
            lng: loc.longitude,
            place_id: p.id ?? null,
            distance_km: haversineKm(center, { lat: loc.latitude, lng: loc.longitude }),
          };
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => a.distance_km - b.distance_km);

      const dedupedRanked: typeof ranked = [];
      for (const cand of ranked) {
        const dup = dedupedRanked.some(
          (kept) =>
            (cand.place_id != null && kept.place_id === cand.place_id) ||
            (kept.name.toLowerCase() === cand.name.toLowerCase() &&
              haversineKm(
                { lat: kept.lat, lng: kept.lng },
                { lat: cand.lat, lng: cand.lng }
              ) < 0.03)
        );
        if (!dup) dedupedRanked.push(cand);
        if (dedupedRanked.length >= FUEL_CANDIDATES_PER_KNOT) break;
      }

      const [primary, ...alternates] = dedupedRanked;
      if (!primary) return { ok: true, data: null };
      return { ok: true, data: { primary, alternates } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < PLACES_MAX_ATTEMPTS - 1) {
        await sleep(350 * (attempt + 1));
        continue;
      }
      console.warn('[fuel] Places nearby search threw after retries:', err);
      return {
        ok: false,
        message: `Places request failed after retries (${msg}). Check network and API key configuration.`,
      };
    }
  }

  return { ok: false, message: lastHttpMessage };
}
