import 'server-only';

import { haversineKm, type LatLng } from '@/lib/polyline';

// ---------------------------------------------------------------------------
// Dump station search via Google Places Text Search API (New).
//
// Text Search is used instead of Nearby Search because "dump station" /
// "motorhome service point" / "aire de service" don't map to a single
// Google place type. Text Search understands natural language queries and
// can match on place names / descriptions across languages.
//
// The search is anchored to a location bias (circle) so results never
// drift to a different region. We also validate results against a max
// distance threshold to reject anything too far from the target.
// ---------------------------------------------------------------------------

/** Max distance (km) from the search center to accept a result. */
const MAX_RESULT_DISTANCE_KM = 50;

/** Default search radius for the location bias circle (meters). */
export const DUMP_STATION_SEARCH_RADIUS_M = 30_000;

/** How many results to request from Google. */
const MAX_RESULT_COUNT = 10;

const PLACES_MAX_ATTEMPTS = 2;
const PLACES_RETRYABLE_HTTP = new Set([429, 500, 503]);

/**
 * Localized search queries by rough region. We fire multiple queries in
 * parallel because a single query may miss results in multilingual regions
 * (e.g. Spain has both "area de servicio autocaravanas" and "RV dump").
 *
 * The country code is derived from the search coordinates at call time.
 * When unknown, we use a generic English fallback.
 */
const REGION_QUERIES: Record<string, string[]> = {
  ES: ['área de servicio autocaravanas', 'vaciado autocaravanas', 'dump station camper'],
  FR: ['aire de service camping-car', 'borne camping-car', 'dump station camping-car'],
  PT: ['área de serviço autocaravana', 'dump station campervan'],
  IT: ['area di servizio camper', 'scarico camper', 'dump station camper'],
  DE: ['Wohnmobil Entsorgungsstation', 'Wohnmobil Ver- und Entsorgung', 'dump station camper'],
  NL: ['camper lospunt', 'dump station camper'],
  GB: ['motorhome service point', 'caravan dump station', 'chemical disposal point'],
  DEFAULT: ['RV dump station', 'motorhome dump station', 'campervan service point'],
};

export type DumpStationCandidate = {
  name: string;
  lat: number;
  lng: number;
  placeId: string;
  googleMapsUri: string | null;
  primaryType: string | null;
  distanceKm: number;
};

export type DumpStationSearchResult = {
  candidates: DumpStationCandidate[];
  /** Non-fatal error messages (e.g. one query failed but others succeeded). */
  warnings: string[];
  /** Fatal error — no results at all. */
  error?: string;
  /** Number of Text Search API calls made (for usage/billing tracking). */
  apiCallsMade: number;
};

type RawTextSearchPlace = {
  id?: string;
  displayName?: { text?: string };
  location?: { latitude: number; longitude: number };
  primaryType?: string;
  googleMapsUri?: string;
  formattedAddress?: string;
};

function readGoogleMapsUri(p: RawTextSearchPlace): string | null {
  if (typeof p.googleMapsUri === 'string' && p.googleMapsUri.startsWith('http')) {
    return p.googleMapsUri;
  }
  return null;
}

function placesTextSearchErrorReason(httpStatus: number, body: string): string {
  if (httpStatus === 403) {
    if (body.includes('PERMISSION_DENIED') || body.includes('blocked')) {
      return 'Places API (New) returned PERMISSION_DENIED — enable "Places API (New)" and check billing.';
    }
    return 'Places API returned 403 — verify API key restrictions allow server-side use.';
  }
  if (httpStatus === 400) {
    return 'Places API returned 400 — "Places API (New)" may not be enabled or query was invalid.';
  }
  return `Places API returned HTTP ${httpStatus}`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Single Text Search call to Google Places API (New).
 */
async function textSearchPlaces(
  query: string,
  center: LatLng,
  radiusM: number,
  apiKey: string,
): Promise<{ ok: true; places: RawTextSearchPlace[] } | { ok: false; message: string }> {
  const payload = JSON.stringify({
    textQuery: query,
    maxResultCount: MAX_RESULT_COUNT,
    locationBias: {
      circle: {
        center: { latitude: center.lat, longitude: center.lng },
        radius: radiusM,
      },
    },
  });

  let lastMessage = 'Text Search failed.';

  for (let attempt = 0; attempt < PLACES_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask':
            'places.id,places.displayName,places.location,places.primaryType,places.googleMapsUri,places.formattedAddress',
        },
        body: payload,
      });

      const bodyText = await res.text().catch(() => '');

      if (!res.ok) {
        lastMessage = placesTextSearchErrorReason(res.status, bodyText);
        if (PLACES_RETRYABLE_HTTP.has(res.status) && attempt < PLACES_MAX_ATTEMPTS - 1) {
          await sleep(350 * (attempt + 1));
          continue;
        }
        return { ok: false, message: lastMessage };
      }

      const data = JSON.parse(bodyText) as { places?: RawTextSearchPlace[] };
      return { ok: true, places: data.places ?? [] };
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
      if (attempt < PLACES_MAX_ATTEMPTS - 1) {
        await sleep(350 * (attempt + 1));
        continue;
      }
    }
  }

  return { ok: false, message: lastMessage };
}

/**
 * Determine which search queries to use based on the country code.
 * Always includes DEFAULT queries as a fallback alongside regional ones.
 */
function queriesForRegion(countryCode: string | null): string[] {
  const regional = countryCode ? REGION_QUERIES[countryCode.toUpperCase()] : null;
  const defaults = REGION_QUERIES.DEFAULT;
  if (!regional) return defaults;
  // Combine regional + default, dedupe
  const all = [...regional, ...defaults];
  return [...new Set(all)];
}

/**
 * Search for dump stations near a point. Fires multiple localized Text Search
 * queries in parallel, deduplicates by placeId, and filters by distance.
 *
 * @param center        Where to search (typically a point on the route)
 * @param apiKey        Google Maps server API key
 * @param countryCode   ISO 3166-1 alpha-2 code for the region (e.g. 'ES', 'FR')
 * @param excludePlaceIds  Place IDs to exclude (for "find another" cycling)
 * @param radiusM       Search radius in meters (default 30km)
 */
export async function searchDumpStations(opts: {
  center: LatLng;
  apiKey: string;
  countryCode: string | null;
  excludePlaceIds?: string[];
  radiusM?: number;
}): Promise<DumpStationSearchResult> {
  const radiusM = opts.radiusM ?? DUMP_STATION_SEARCH_RADIUS_M;
  const queries = queriesForRegion(opts.countryCode);
  const excludeSet = new Set(opts.excludePlaceIds ?? []);
  const warnings: string[] = [];

  // Fire all queries in parallel
  const results = await Promise.all(
    queries.map((q) => textSearchPlaces(q, opts.center, radiusM, opts.apiKey))
  );

  const apiCallsMade = results.length;

  // Collect all places, deduplicate by placeId
  const seen = new Map<string, DumpStationCandidate>();

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result.ok) {
      warnings.push(`Query "${queries[i]}": ${result.message}`);
      continue;
    }
    for (const p of result.places) {
      if (!p.id || !p.location?.latitude || !p.location?.longitude) continue;
      if (excludeSet.has(p.id)) continue;
      if (seen.has(p.id)) continue;

      const lat = p.location.latitude;
      const lng = p.location.longitude;
      const distanceKm = haversineKm(opts.center, { lat, lng });

      // Reject results too far from the search center
      if (distanceKm > MAX_RESULT_DISTANCE_KM) continue;

      seen.set(p.id, {
        name: (p.displayName?.text ?? '').trim() || 'Dump station',
        lat,
        lng,
        placeId: p.id,
        googleMapsUri: readGoogleMapsUri(p),
        primaryType: typeof p.primaryType === 'string' ? p.primaryType : null,
        distanceKm,
      });
    }
  }

  const candidates = [...seen.values()].sort((a, b) => a.distanceKm - b.distanceKm);

  // If ALL queries failed, report fatal error
  const allFailed = results.every((r) => !r.ok);
  if (allFailed && candidates.length === 0) {
    return {
      candidates: [],
      warnings,
      error: `All dump station searches failed: ${warnings.join('; ')}`,
      apiCallsMade,
    };
  }

  return { candidates, warnings, apiCallsMade };
}

/**
 * Find a single best dump station near a point. Convenience wrapper around
 * searchDumpStations that returns the closest candidate.
 */
export async function findNearestDumpStation(opts: {
  center: LatLng;
  apiKey: string;
  countryCode: string | null;
  excludePlaceIds?: string[];
}): Promise<{
  candidate: DumpStationCandidate | null;
  apiCallsMade: number;
  error?: string;
}> {
  const result = await searchDumpStations(opts);
  return {
    candidate: result.candidates[0] ?? null,
    apiCallsMade: result.apiCallsMade,
    error: result.error,
  };
}
