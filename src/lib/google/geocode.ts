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
 * Endpoint: Google **Places API (New)** `places:searchText` — the same API the
 * fuel-pricing provider uses (`fuelPricing/providers/google.ts`). It handles
 * businesses, addresses, AND cities in one call. We deliberately do NOT use the
 * legacy `place/textsearch/json` endpoint (that requires the deprecated "Places
 * API" SKU, which this project does not have enabled — it caused a 100%
 * REQUEST_DENIED outage) and we do NOT keep a Geocoding-API fallback: if Places
 * (New) can't resolve it, we return not_found/unavailable and let the caller
 * ask the user for a Maps link rather than silently trying a second product.
 *
 * Key: the one app-wide key, NEXT_PUBLIC_GOOGLE_MAPS_API_KEY (there is no
 * separate server key — see CLAUDE.md). Places API (New) must be enabled on it.
 *
 * The result is tri-state on purpose (see GeocodeResult): a coarse or
 * ambiguous match is NOT silently returned as if it were exact. Callers
 * (Penny) decide whether a city centroid answers the question or whether to
 * ask the user to sharpen it.
 */

const SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';
const FETCH_TIMEOUT_MS = 5000;

/** Places (New) fields we need back. Keep tight — field mask drives billing SKU. */
const FIELD_MASK =
  'places.location,places.displayName,places.formattedAddress,places.types,places.id';

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
   * Optional region bias (two-letter code, e.g. "no" for Norway) — nudges
   * Google toward the right country when the query is a bare name. Not required.
   */
  region?: string;
}

/** Shape of one place in a Places (New) searchText response. */
interface RawPlace {
  id?: string;
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  displayName?: { text?: string };
  types?: string[];
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
  const lat = p.location?.latitude;
  const lng = p.location?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const label = (p.displayName?.text || p.formattedAddress || '').trim();
  if (!label) return null;
  return {
    lat,
    lng,
    label,
    address: p.formattedAddress?.trim() || undefined,
    granularity: classifyGranularity(p.types),
    place_id: p.id || undefined,
  };
}

type FetchOutcome =
  | { kind: 'ok'; places: RawPlace[] }
  /** Transport-level failure (network/timeout) — surface as unavailable, not not_found. */
  | { kind: 'network' }
  /** API-level rejection (bad key, API not enabled, quota) — surface as unavailable. */
  | { kind: 'denied'; reason: string };

/**
 * One Places (New) searchText call. POST with the key in X-Goog-Api-Key and the
 * field mask in X-Goog-FieldMask (Places New requires both). Distinguishes a
 * transport failure from an API rejection so the caller can tell "lookup is
 * down" from "no such place".
 */
async function searchText(
  query: string,
  apiKey: string,
  region: string | undefined,
  fetchImpl: typeof fetch,
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = { textQuery: query };
    if (region) body.regionCode = region.toUpperCase();

    const res = await fetchImpl(SEARCH_TEXT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Places (New) errors carry { error: { code, message, status } }.
      let reason = `Places API (New) HTTP ${res.status}.`;
      try {
        const err = (await res.json()) as { error?: { message?: string; status?: string } };
        if (err?.error?.message) reason = err.error.message;
      } catch {
        // Non-JSON error body — keep the status-based reason.
      }
      return { kind: 'denied', reason };
    }

    const data = (await res.json()) as { places?: RawPlace[] };
    return { kind: 'ok', places: Array.isArray(data.places) ? data.places : [] };
  } catch {
    return { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn the raw candidate list into a tri-state result. Scores ambiguity so two
 * genuinely different precise places force a clarification while same-named
 * cities do not.
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
 * Resolve a free-text place/address/city to coordinates via Places API (New).
 * Never guesses — returns `not_found` rather than a best-effort wrong pin, and
 * `unavailable` (not a silent failure) when there's no key or the API errors.
 * There is no second-product fallback: one call, one honest answer.
 */
export async function geocodePlace(query: string, opts: GeocodeOptions = {}): Promise<GeocodeResult> {
  const q = query.trim();
  if (!q) return { status: 'not_found' };

  const apiKey = opts.apiKey ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return { status: 'unavailable', reason: 'No Google Maps API key configured.' };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;

  const outcome = await searchText(q, apiKey, opts.region, fetchImpl);
  if (outcome.kind === 'denied') {
    return { status: 'unavailable', reason: outcome.reason };
  }
  if (outcome.kind === 'network') {
    return { status: 'unavailable', reason: 'Geocoding lookup failed (network/timeout).' };
  }

  const decided = decide(outcome.places);
  if (decided) return decided;
  return { status: 'not_found' };
}
