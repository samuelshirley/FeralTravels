import 'server-only';

/**
 * Deterministic place → coordinates resolver.
 *
 * Why this exists: Penny used to turn a place name ("Bergen", "Clean Kokos
 * laundromat") into lat/lng from her own training knowledge. She was wrong
 * often enough to drop the driver "kind of close" — near the right city but
 * not the right spot. This service replaces that guessing with an
 * authoritative lookup against Google. The LLM supplies the query string;
 * the coordinates always come from here.
 *
 * Strategy: Places Text Search first (handles businesses, addresses, AND
 * cities), Geocoding API as a fallback for the rare query Text Search misses.
 * Both use the same key the rest of the app already uses
 * (NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) — geocoding/Places must be enabled on it.
 *
 * The result is tri-state on purpose (see GeocodeResult): a coarse or
 * ambiguous match is NOT silently returned as if it were exact. Callers
 * (Penny) decide whether a city centroid answers the question or whether to
 * ask the user to sharpen it.
 */

const TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const FETCH_TIMEOUT_MS = 5000;

/** Two precise candidates farther apart than this count as genuinely different places. */
const AMBIGUITY_KM = 2;
const MAX_CANDIDATES = 4;

/**
 * How exact the matched point is.
 * - `precise`  — a specific establishment, address, premise, or POI.
 * - `locality` — a town/city centroid (the "middle of the city").
 * - `area`     — a region / administrative area centroid (coarser than a city).
 * - `country`  — a country centroid (almost always too coarse to route to).
 */
export type GeocodeGranularity = 'precise' | 'locality' | 'area' | 'country';

export interface GeocodeMatch {
  lat: number;
  lng: number;
  /** Best human label — place/business name when available, else the address. */
  label: string;
  /** Full formatted address when Google provides one. */
  address?: string;
  granularity: GeocodeGranularity;
  /** Google place_id, useful for dedupe / building a Maps link. */
  place_id?: string;
}

export type GeocodeResult =
  | { status: 'resolved'; match: GeocodeMatch; other_candidates: GeocodeMatch[] }
  | { status: 'ambiguous'; candidates: GeocodeMatch[] }
  | { status: 'not_found' }
  | { status: 'unavailable'; reason: string };

export interface GeocodeOptions {
  /** Override the API key (tests / non-default deployments). */
  apiKey?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /**
   * Optional region bias (ccTLD, e.g. "no" for Norway) — nudges Google toward
   * the right country when the query is a bare name. Not required.
   */
  region?: string;
}

interface RawPlace {
  name?: string;
  formatted_address?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
  types?: string[];
  place_id?: string;
}

const PRECISE_TYPES = new Set([
  'street_address',
  'premise',
  'subpremise',
  'establishment',
  'point_of_interest',
  'park',
  'campground',
  'natural_feature',
  'airport',
  'transit_station',
  'intersection',
  'route',
]);

function classifyGranularity(types: string[] | undefined): GeocodeGranularity {
  const t = types ?? [];
  if (t.some((x) => PRECISE_TYPES.has(x))) return 'precise';
  if (t.includes('locality') || t.includes('postal_town') || t.some((x) => x.startsWith('sublocality'))) {
    return 'locality';
  }
  if (t.includes('country')) return 'country';
  if (t.some((x) => x.startsWith('administrative_area_level')) || t.includes('colloquial_area')) {
    return 'area';
  }
  // Places establishments sometimes omit a recognizable type — treat the
  // presence of a name as a precise POI rather than an area.
  return 'precise';
}

/** Rough great-circle distance in km — enough to tell "same place" from "different city". */
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function toMatch(p: RawPlace): GeocodeMatch | null {
  const lat = p.geometry?.location?.lat;
  const lng = p.geometry?.location?.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const label = (p.name || p.formatted_address || '').trim();
  if (!label) return null;
  return {
    lat,
    lng,
    label,
    address: p.formatted_address?.trim() || undefined,
    granularity: classifyGranularity(p.types),
    place_id: p.place_id || undefined,
  };
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ status?: string; results?: RawPlace[]; error_message?: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as { status?: string; results?: RawPlace[]; error_message?: string };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn the raw candidate list into a tri-state result. Shared by Text Search
 * and Geocoding so both score ambiguity the same way.
 */
function decide(rawResults: RawPlace[]): GeocodeResult | null {
  const matches = rawResults.map(toMatch).filter((m): m is GeocodeMatch => m !== null);
  if (matches.length === 0) return null;

  const [top, ...rest] = matches;

  // Only flag ambiguity for PRECISE matches — two different cities/regions
  // sharing a name is expected and a centroid is still a fine answer. Two
  // distinct precise places (e.g. a chain with branches in different towns)
  // is the case where we must ask which one.
  if (top.granularity === 'precise') {
    const distinct = matches
      .filter((m) => m.granularity === 'precise')
      .filter((m, i, arr) => arr.findIndex((o) => haversineKm(o, m) < AMBIGUITY_KM) === i);
    if (distinct.length > 1) {
      return { status: 'ambiguous', candidates: distinct.slice(0, MAX_CANDIDATES) };
    }
  }

  return { status: 'resolved', match: top, other_candidates: rest.slice(0, MAX_CANDIDATES) };
}

/**
 * Resolve a free-text place/address/city to coordinates. Never guesses —
 * returns `not_found` rather than a best-effort wrong pin, and `unavailable`
 * (not a silent failure) when there's no key or the API errors.
 */
export async function geocodePlace(query: string, opts: GeocodeOptions = {}): Promise<GeocodeResult> {
  const q = query.trim();
  if (!q) return { status: 'not_found' };

  const apiKey = opts.apiKey ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return { status: 'unavailable', reason: 'No Google Maps API key configured.' };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const regionParam = opts.region ? `&region=${encodeURIComponent(opts.region)}` : '';

  // 1) Places Text Search — handles businesses, addresses, and cities.
  const textUrl = `${TEXT_SEARCH_URL}?query=${encodeURIComponent(q)}${regionParam}&key=${apiKey}`;
  const text = await fetchJson(textUrl, fetchImpl);
  if (text && (text.status === 'REQUEST_DENIED' || text.status === 'INVALID_REQUEST')) {
    return {
      status: 'unavailable',
      reason: text.error_message || `Places Text Search ${text.status}.`,
    };
  }
  if (text && text.status === 'OK' && text.results && text.results.length > 0) {
    const decided = decide(text.results);
    if (decided) return decided;
  }

  // 2) Geocoding API fallback — catches the occasional bare address Text
  // Search misses, and gives a clean city/region centroid.
  const geoUrl = `${GEOCODE_URL}?address=${encodeURIComponent(q)}${regionParam}&key=${apiKey}`;
  const geo = await fetchJson(geoUrl, fetchImpl);
  if (geo && geo.status === 'REQUEST_DENIED') {
    return { status: 'unavailable', reason: geo.error_message || 'Geocoding REQUEST_DENIED.' };
  }
  if (geo && geo.status === 'OK' && geo.results && geo.results.length > 0) {
    const decided = decide(geo.results);
    if (decided) return decided;
  }

  // If both ran cleanly but found nothing, it's genuinely not found. If both
  // failed at the network level, surface that as unavailable (not "not found"
  // — we don't want Penny telling the user a real place doesn't exist).
  if (text === null && geo === null) {
    return { status: 'unavailable', reason: 'Geocoding lookup failed (network/timeout).' };
  }
  return { status: 'not_found' };
}
