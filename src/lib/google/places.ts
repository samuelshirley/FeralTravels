/**
 * Google Places (New) — Finn's station-data source.
 *
 * Replaces the OSM Overpass client. We call Text Search (New) in
 * "search along route" mode: one POST with the leg's encoded polyline returns
 * the fuel stations that sit along that route, ranked by relevance. Google's
 * docs allow ANY valid encoded polyline here — it does not have to come from the
 * Routes API — so we feed the leg's already-stored Google geometry.
 *
 * Pure + injectable, same shape as the old Overpass module:
 *   - `parsePlacesFuel` turns a Places JSON response into typed stations
 *   - `searchFuelAlongRoute` wires it together over an injectable `fetch`
 *
 * ToS note: we persist only the `placeId` long-term (explicitly allowed) plus
 * the coords/name needed to render a stop the user chose. We do NOT keep a
 * scraped copy of Google's dataset.
 *
 * Cost: the field mask below is deliberately limited to Text Search *Pro*-tier
 * fields (no opening hours / reviews / photos), which bills as the Pro SKU
 * (5,000 free calls/month). Combined with Finn's lazy fuel cache
 * (`FUEL_CACHE_TTL_MS`) real usage stays in the low dozens. Do NOT add
 * Enterprise-tier fields to this mask without a reason.
 */

/** Text Search (New) endpoint. */
export const PLACES_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

/**
 * Server-side Google key: never the referrer-locked NEXT_PUBLIC key first
 * (Google 403s browser keys from Node). Prefer GOOGLE_MAPS_SERVER_API_KEY,
 * fall back to the public key for local dev. Inlined (rather than importing the
 * `server-only` helper) so this module stays unit-testable.
 */
function serverApiKey(): string | undefined {
  const server = process.env.GOOGLE_MAPS_SERVER_API_KEY?.trim();
  if (server) return server;
  const pub = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim();
  return pub || undefined;
}

/**
 * Pro-tier field mask. `id` is the ToS-storable identity; `location`/
 * `displayName` render the stop; `types` lets the filter drop truck stops;
 * `businessStatus` drops permanently-closed forecourts.
 */
export const PLACES_FIELD_MASK =
  'places.id,places.displayName,places.location,places.types,places.googleMapsUri,places.businessStatus';

/**
 * A fuel station as returned by Google Places (New). The `placeId` is stable and
 * ToS-storable; `brand` is always null (Places New has no separate brand field —
 * the name carries the brand, which the truck-name filter still reads).
 */
export interface FuelStation {
  placeId: string;
  lat: number;
  lng: number;
  name: string | null;
  brand: string | null;
  /** Place types Google returned, e.g. `['gas_station']`. */
  types: string[];
  /** Direct Google Maps URI when Google supplies one. */
  googleMapsUri: string | null;
}

// ── Parsing ────────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Pull lat/lng from a Places `location` object. */
function coordsOf(loc: unknown): { lat: number; lng: number } | null {
  const rec = asRecord(loc);
  if (!rec) return null;
  const lat = rec.latitude;
  const lng = rec.longitude;
  if (typeof lat === 'number' && typeof lng === 'number') return { lat, lng };
  return null;
}

/**
 * Parse a Places `searchText` JSON response into typed fuel stations. Malformed
 * or coordinate-less places are skipped rather than thrown (one bad element
 * shouldn't sink a corridor). Permanently/temporarily closed places are dropped.
 * Deduplicates by `placeId`.
 */
export function parsePlacesFuel(json: unknown): FuelStation[] {
  const root = asRecord(json);
  const places = root?.places;
  if (!Array.isArray(places)) return [];

  const byId = new Map<string, FuelStation>();
  for (const raw of places) {
    const el = asRecord(raw);
    if (!el) continue;
    if (typeof el.id !== 'string' || el.id.length === 0) continue;

    const coords = coordsOf(el.location);
    if (!coords) continue;

    // Drop closed forecourts. Missing status → keep (Google omits it when OK).
    const status = typeof el.businessStatus === 'string' ? el.businessStatus : 'OPERATIONAL';
    if (status !== 'OPERATIONAL') continue;

    const displayName = asRecord(el.displayName);
    const name = typeof displayName?.text === 'string' ? displayName.text : null;

    byId.set(el.id, {
      placeId: el.id,
      lat: coords.lat,
      lng: coords.lng,
      name,
      brand: null,
      types: asStringArray(el.types),
      googleMapsUri: typeof el.googleMapsUri === 'string' ? el.googleMapsUri : null,
    });
  }
  return [...byId.values()];
}

// ── Fetch ────────────────────────────────────────────────────────────────

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface SearchAlongRouteDeps {
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: FetchLike;
  /** Override the API key (defaults to the server key helper). */
  apiKey?: string;
  /** Override the endpoint. */
  endpoint?: string;
}

/**
 * Search for fuel stations along an encoded polyline and return typed stations.
 * Throws on missing key, transport error, or HTTP/parse error — Finn's caller
 * decides how to surface it (never swallowed), same contract the Overpass client
 * had. An empty-but-valid response returns `[]`.
 *
 * Note: Text Search (New) returns up to 20 results per call ranked by relevance
 * along the route. For the road-trip legs Finn plans this comfortably covers a
 * well-served route; a genuinely remote leg that needs more is handled upstream
 * as a `no_stations_found` warning, not a crash.
 */
export async function searchFuelAlongRoute(
  encodedPolyline: string,
  deps?: SearchAlongRouteDeps
): Promise<FuelStation[]> {
  if (!encodedPolyline || encodedPolyline.length === 0) {
    throw new Error('searchFuelAlongRoute: empty encoded polyline');
  }
  const fetchImpl = deps?.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!fetchImpl) throw new Error('searchFuelAlongRoute: no fetch implementation available');
  const apiKey = deps?.apiKey ?? serverApiKey();
  if (!apiKey) {
    throw new Error(
      'No Google Maps server API key configured. Set GOOGLE_MAPS_SERVER_API_KEY (Places API New enabled, no referrer restriction).'
    );
  }
  const endpoint = deps?.endpoint ?? PLACES_SEARCH_URL;

  const body = JSON.stringify({
    textQuery: 'gas station',
    includedType: 'gas_station',
    searchAlongRouteParameters: { polyline: { encodedPolyline } },
  });

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': PLACES_FIELD_MASK,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Places search failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Places search returned non-JSON response');
  }
  return parsePlacesFuel(json);
}
