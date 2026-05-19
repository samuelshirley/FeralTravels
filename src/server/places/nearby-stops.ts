import 'server-only';

import { haversineKm, type LatLng } from '@/lib/polyline';

/**
 * Google Places types by stop category.
 * These are the "included types" for the Nearby Search (New) API.
 */
const CATEGORY_TYPES: Record<StopCategory, string[]> = {
  fuel: ['gas_station'],
  groceries: ['supermarket', 'grocery_store'],
  water: ['drinking_water', 'rest_stop', 'tourist_attraction'],
  parks: ['dog_park', 'park', 'national_park', 'state_park', 'picnic_ground'],
};

export type StopCategory = 'fuel' | 'groceries' | 'water' | 'parks';

export interface NearbyStopResult {
  name: string;
  lat: number;
  lng: number;
  placeId: string | null;
  googleMapsUri: string | null;
  distanceKm: number;
  category: StopCategory;
}

type RawPlaceRow = {
  id?: string;
  displayName?: { text?: string };
  location?: { latitude: number; longitude: number };
  primaryType?: string;
  googleMapsUri?: string;
  google_maps_uri?: string;
};

function readUri(p: RawPlaceRow): string | null {
  if (typeof p.googleMapsUri === 'string' && p.googleMapsUri.startsWith('http')) return p.googleMapsUri;
  if (typeof p.google_maps_uri === 'string' && p.google_maps_uri.startsWith('http')) return p.google_maps_uri;
  return null;
}

/**
 * Search for places of a specific category near a coordinate.
 * Returns up to `maxResults` sorted by distance.
 */
export async function nearbyStopsByCategory(
  center: LatLng,
  category: StopCategory,
  apiKey: string,
  opts?: { radiusM?: number; maxResults?: number }
): Promise<{ results: NearbyStopResult[]; error?: string }> {
  const radiusM = opts?.radiusM ?? 10000;
  const maxResults = opts?.maxResults ?? 10;
  const includedTypes = CATEGORY_TYPES[category];

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'places.displayName,places.location,places.id,places.primaryType,places.googleMapsUri',
      },
      body: JSON.stringify({
        includedTypes,
        maxResultCount: 20,
        rankPreference: 'DISTANCE',
        locationRestriction: {
          circle: {
            center: { latitude: center.lat, longitude: center.lng },
            radius: radiusM,
          },
        },
      }),
    });

    if (!res.ok) {
      const bodyText = await res.text();
      return {
        results: [],
        error: `Places API returned ${res.status}: ${bodyText.slice(0, 160)}`,
      };
    }

    const data = (await res.json()) as { places?: RawPlaceRow[] };
    const places = data.places ?? [];

    const results: NearbyStopResult[] = places
      .map((p) => {
        const lat = p.location?.latitude;
        const lng = p.location?.longitude;
        if (lat == null || lng == null) return null;
        return {
          name: (p.displayName?.text ?? '').trim() || category,
          lat,
          lng,
          placeId: p.id ?? null,
          googleMapsUri: readUri(p),
          distanceKm: haversineKm(center, { lat, lng }),
          category,
        };
      })
      .filter((x): x is NearbyStopResult => x !== null)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, maxResults);

    return { results };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { results: [], error: msg };
  }
}

/**
 * Search multiple points along a route for a given category.
 * Samples points at intervals, deduplicates results by placeId.
 */
export async function nearbyStopsAlongRoute(
  points: LatLng[],
  category: StopCategory,
  apiKey: string,
  opts?: { radiusM?: number; maxResults?: number }
): Promise<{ results: NearbyStopResult[]; error?: string }> {
  const maxResults = opts?.maxResults ?? 10;
  const errors: string[] = [];
  const seen = new Set<string>();
  const all: NearbyStopResult[] = [];

  for (const point of points) {
    const { results, error } = await nearbyStopsByCategory(
      point,
      category,
      apiKey,
      { radiusM: opts?.radiusM ?? 5000, maxResults: 5 }
    );
    if (error) errors.push(error);
    for (const r of results) {
      const key = r.placeId ?? `${r.lat.toFixed(5)}:${r.lng.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(r);
    }
  }

  all.sort((a, b) => a.distanceKm - b.distanceKm);
  return {
    results: all.slice(0, maxResults),
    error: errors.length > 0 && all.length === 0 ? errors[0] : undefined,
  };
}
