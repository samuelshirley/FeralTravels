import 'server-only';
import type { FindSpotsInput, OvernightSpot, OvernightCategory } from './types';

// Server-only Google API key. We deliberately use a separate env from
// NEXT_PUBLIC_GOOGLE_MAPS_API_KEY so the public key (with HTTP referrer
// restrictions for the Maps JS SDK) doesn't need to also allow Places.
// Falls back to the public key if a server key isn't configured — works in
// dev but should be split for production.
function googleKey(): string | null {
  return (
    process.env.GOOGLE_PLACES_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
    null
  );
}

interface PlacesResult {
  place_id?: string;
  name?: string;
  types?: string[];
  geometry?: { location?: { lat?: number; lng?: number } };
  vicinity?: string;
  business_status?: string;
}

interface PlacesResponse {
  status?: string;
  results?: PlacesResult[];
  error_message?: string;
}

const QUERY_TYPES: Array<{ type: string; category: OvernightCategory; nameHint: string }> = [
  { type: 'park', category: 'dog_park', nameHint: 'dog park' },
  { type: 'rv_park', category: 'parking', nameHint: 'rv park' },
  // 'rest_area' isn't a documented Places type — use keyword search below.
];

const KEYWORD_QUERIES: Array<{ keyword: string; category: OvernightCategory }> = [
  { keyword: 'rest area', category: 'rest_area' },
  { keyword: 'highway rest area', category: 'rest_area' },
];

function metresFromKm(km: number): number {
  // Places Nearby Search caps radius at 50000m.
  return Math.min(50_000, Math.round(km * 1000));
}

async function nearbySearch(params: URLSearchParams, key: string): Promise<PlacesResult[]> {
  params.set('key', key);
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params.toString()}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const json = (await res.json()) as PlacesResponse;
    if (json.status && json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
      console.warn('[overnight/google] Places error', json.status, json.error_message);
      return [];
    }
    return json.results ?? [];
  } catch {
    return [];
  }
}

export async function fetchGooglePlacesSpots(input: FindSpotsInput): Promise<OvernightSpot[]> {
  const key = googleKey();
  if (!key) return [];

  const radius = String(metresFromKm(input.radiusKm));
  const location = `${input.lat},${input.lng}`;

  const out: OvernightSpot[] = [];
  const seen = new Set<string>();

  for (const q of QUERY_TYPES) {
    const params = new URLSearchParams({ location, radius, type: q.type });
    const results = await nearbySearch(params, key);
    for (const r of results) {
      const id = r.place_id;
      if (!id || seen.has(id)) continue;
      const lat = r.geometry?.location?.lat;
      const lng = r.geometry?.location?.lng;
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;
      // Skip closed places.
      if (r.business_status === 'CLOSED_PERMANENTLY') continue;
      // Heuristic: dog parks are useful as informal overnight spots only when
      // they have a parking lot. We can't know for certain from Places, so
      // include the top results and let the user decide.
      seen.add(id);
      out.push({
        source: 'google_places',
        sourceId: id,
        name: r.name?.trim() || q.nameHint,
        lat,
        lng,
        category: q.category,
        isFree: true,
        description: r.vicinity ?? null,
        sourceUrl: `https://www.google.com/maps/place/?q=place_id:${id}`,
      });
      if (input.perSourceLimit && out.length >= input.perSourceLimit) return out;
    }
  }

  for (const q of KEYWORD_QUERIES) {
    const params = new URLSearchParams({ location, radius, keyword: q.keyword });
    const results = await nearbySearch(params, key);
    for (const r of results) {
      const id = r.place_id;
      if (!id || seen.has(id)) continue;
      const lat = r.geometry?.location?.lat;
      const lng = r.geometry?.location?.lng;
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;
      if (r.business_status === 'CLOSED_PERMANENTLY') continue;
      seen.add(id);
      out.push({
        source: 'google_places',
        sourceId: id,
        name: r.name?.trim() || q.keyword,
        lat,
        lng,
        category: q.category,
        isFree: true,
        description: r.vicinity ?? null,
        sourceUrl: `https://www.google.com/maps/place/?q=place_id:${id}`,
      });
      if (input.perSourceLimit && out.length >= input.perSourceLimit) return out;
    }
  }

  return out;
}
