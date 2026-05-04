import 'server-only';

import { haversineKm, type LatLng } from '@/lib/polyline';

/** Primary search radius (m). Matches “within 5 km” product copy. */
export const NEARBY_PARKS_INNER_RADIUS_M = 5000;
/** Fallback when fewer than three useful hits exist in the inner circle. Places allows up to 50 km. */
export const NEARBY_PARKS_OUTER_RADIUS_M = 50000;

const INNER_KM_LIMIT = NEARBY_PARKS_INNER_RADIUS_M / 1000;

export type NearbyParksSuggestion = {
  name: string;
  lat: number;
  lng: number;
  placeId: string | null;
  primaryType: string | null;
  googleMapsUri: string | null;
  distanceKm: number;
  /** Haversine from anchor vs 5 km product threshold (not Places circle edge). */
  within5Km: boolean;
};

export type NearbyParksPayload = {
  dogParks: NearbyParksSuggestion[];
  parks: NearbyParksSuggestion[];
};

function placesNearbyErrorReason(httpStatus: number, body: string): string {
  if (httpStatus === 403) {
    if (body.includes('PERMISSION_DENIED') || body.includes('blocked')) {
      return 'Places API (New) returned PERMISSION_DENIED — enable "Places API (New)" and check billing.';
    }
    return 'Places API returned 403 — verify API key restrictions allow server-side use.';
  }
  if (httpStatus === 400) {
    return 'Places API returned 400 — "Places API (New)" may not be enabled.';
  }
  return `Places API returned HTTP ${httpStatus}`;
}

/** Green-space types (Nearby OR semantics). Exclude dog runs via primaryType filter afterward. */
const PARK_INCLUDED_TYPES = [
  'park',
  'national_park',
  'state_park',
  'city_park',
  'picnic_ground',
];

type NearbySearchOutcome =
  | { ok: true; places: Array<RawPlaceRow> }
  | { ok: false; httpStatus: number; bodySnippet: string };

type RawPlaceRow = {
  id?: string;
  displayName?: { text?: string };
  location?: { latitude: number; longitude: number };
  primaryType?: string;
};

function readGoogleMapsUri(p: RawPlaceRow & Record<string, unknown>): string | null {
  const a = (p as { googleMapsUri?: string }).googleMapsUri;
  if (typeof a === 'string' && a.startsWith('http')) return a;
  const b = (p as { google_maps_uri?: string }).google_maps_uri;
  if (typeof b === 'string' && b.startsWith('http')) return b;
  return null;
}

async function searchNearbyPlaces(
  center: LatLng,
  radiusM: number,
  includedTypes: string[],
  apiKey: string
): Promise<NearbySearchOutcome> {
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
    const bodyText = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        bodySnippet: `${placesNearbyErrorReason(res.status, bodyText)} — ${bodyText.slice(0, 160)}`,
      };
    }
    const data = JSON.parse(bodyText) as { places?: RawPlaceRow[] };
    return { ok: true, places: data.places ?? [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, httpStatus: 0, bodySnippet: msg };
  }
}

function toRows(
  raw: RawPlaceRow[],
  anchor: LatLng,
  filter: (primaryType: string | null) => boolean
): Omit<NearbyParksSuggestion, 'within5Km'>[] {
  const rows: Omit<NearbyParksSuggestion, 'within5Km'>[] = [];
  for (const p of raw) {
    const lat = p.location?.latitude;
    const lng = p.location?.longitude;
    if (lat == null || lng == null) continue;
    const pt = typeof p.primaryType === 'string' ? p.primaryType : null;
    if (!filter(pt)) continue;
    const name = (p.displayName?.text ?? '').trim() || 'Park';
    const distanceKm = haversineKm(anchor, { lat, lng });
    rows.push({
      name,
      lat,
      lng,
      placeId: p.id ?? null,
      primaryType: pt,
      googleMapsUri: readGoogleMapsUri(p as RawPlaceRow & Record<string, unknown>),
      distanceKm,
    });
  }
  rows.sort((a, b) => a.distanceKm - b.distanceKm);
  return rows;
}

function dedupeKey(s: Omit<NearbyParksSuggestion, 'within5Km'>): string {
  return s.placeId ?? `${s.lat.toFixed(5)}:${s.lng.toFixed(5)}:${s.name}`;
}

function annotateWithin5Km(
  rows: Omit<NearbyParksSuggestion, 'within5Km'>[]
): NearbyParksSuggestion[] {
  return rows.map((r) => ({
    ...r,
    within5Km: r.distanceKm <= INNER_KM_LIMIT + 1e-6,
  }));
}

/**
 * Combine inner + outer searches: prefer up to `cap` spots; fill from outer when fewer than three in inner results.
 */
async function rankedSuggestions(opts: {
  anchor: LatLng;
  apiKey: string;
  includedTypes: string[];
  innerRadiusM: number;
  outerRadiusM: number;
  filter: (primaryType: string | null) => boolean;
  cap?: number;
}): Promise<{ rows: NearbyParksSuggestion[]; error?: string }> {
  const cap = opts.cap ?? 3;
  const inner = await searchNearbyPlaces(opts.anchor, opts.innerRadiusM, opts.includedTypes, opts.apiKey);
  if (!inner.ok) {
    return {
      rows: [],
      error: inner.bodySnippet,
    };
  }
  const innerRows = annotateWithin5Km(toRows(inner.places, opts.anchor, opts.filter));

  /** Prefer inner-circle hits first (straight-line km), already sorted by distance. */
  const innerWithin = innerRows.filter((r) => r.within5Km);
  const picked: NearbyParksSuggestion[] = [];
  const seen = new Set<string>();

  function takeFrom(list: NearbyParksSuggestion[]) {
    for (const r of list) {
      if (picked.length >= cap) break;
      const key = dedupeKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(r);
    }
  }

  takeFrom(innerWithin);
  if (picked.length >= cap) {
    return { rows: picked.slice(0, cap) };
  }

  /** Second pass: remainder of inner-search results beyond 5 km (Places still capped at inner radius). */
  takeFrom(innerRows.filter((r) => !r.within5Km));

  if (picked.length >= cap) {
    return { rows: picked.slice(0, cap) };
  }

  const outer = await searchNearbyPlaces(opts.anchor, opts.outerRadiusM, opts.includedTypes, opts.apiKey);
  if (!outer.ok) {
    if (picked.length > 0) return { rows: picked.slice(0, cap), error: outer.bodySnippet };
    return { rows: [], error: outer.bodySnippet };
  }
  const outerRows = annotateWithin5Km(toRows(outer.places, opts.anchor, opts.filter));
  takeFrom(outerRows);

  return { rows: picked.slice(0, cap) };
}

/**
 * Nearby dog parks + general parks relative to leg end anchor. Uses Places API (New).
 * Returns partial results with `error` if a request fails and nothing was salvageable earlier.
 */
export async function nearbyParksAround(
  anchor: LatLng,
  apiKey: string
): Promise<{ payload: NearbyParksPayload; error?: string }> {
  const errors: string[] = [];

  const dog = await rankedSuggestions({
    anchor,
    apiKey,
    includedTypes: ['dog_park'],
    innerRadiusM: NEARBY_PARKS_INNER_RADIUS_M,
    outerRadiusM: NEARBY_PARKS_OUTER_RADIUS_M,
    filter: () => true,
  });
  if (dog.error) errors.push(`Dog parks: ${dog.error}`);

  const green = await rankedSuggestions({
    anchor,
    apiKey,
    includedTypes: PARK_INCLUDED_TYPES,
    innerRadiusM: NEARBY_PARKS_INNER_RADIUS_M,
    outerRadiusM: NEARBY_PARKS_OUTER_RADIUS_M,
    filter: (primary) => primary !== 'dog_park',
  });
  if (green.error) errors.push(`Parks: ${green.error}`);

  const payload: NearbyParksPayload = {
    dogParks: dog.rows,
    parks: green.rows,
  };

  const fatal =
    dog.rows.length === 0 &&
    green.rows.length === 0 &&
    errors.length > 0
      ? errors.join(' ')
      : undefined;

  return { payload, error: fatal };
}

export type StretchBreakCandidate = {
  name: string;
  lat: number;
  lng: number;
  placeId: string | null;
  googleMapsUri: string | null;
  primaryType: string | null;
};

export type StretchBreakLookup = {
  candidate: StretchBreakCandidate | null;
  /** Number of Places Nearby Search calls actually made (1 or 2). For usage logging. */
  placesCallsMade: number;
};

/**
 * Single best dog-park-or-park near a knot on the route (stretch break).
 * Prefers dog_park; falls back to green-space types excluding dog runs as duplicate parks.
 *
 * Returns the actual Places call count alongside the candidate so callers
 * can report accurate usage to billing/telemetry without re-deriving it.
 */
export async function nearestStretchBreakPlace(
  center: LatLng,
  apiKey: string
): Promise<StretchBreakLookup> {
  let placesCallsMade = 0;

  const tryDog = await searchNearbyPlaces(
    center,
    NEARBY_PARKS_INNER_RADIUS_M,
    ['dog_park'],
    apiKey
  );
  placesCallsMade += 1;

  let raw: RawPlaceRow[] | null = null;
  if (tryDog.ok && tryDog.places.length > 0) {
    raw = tryDog.places;
  } else {
    const tryGreen = await searchNearbyPlaces(
      center,
      NEARBY_PARKS_INNER_RADIUS_M,
      PARK_INCLUDED_TYPES,
      apiKey
    );
    placesCallsMade += 1;
    if (!tryGreen.ok) return { candidate: null, placesCallsMade };
    raw = tryGreen.places.filter(
      (p) => typeof p.primaryType !== 'string' || p.primaryType !== 'dog_park'
    );
  }
  if (!raw || raw.length === 0) return { candidate: null, placesCallsMade };

  const mapped = raw
    .map((p) => {
      const lat = p.location?.latitude;
      const lng = p.location?.longitude;
      if (lat == null || lng == null) return null;
      const primaryType = typeof p.primaryType === 'string' ? p.primaryType : null;
      return {
        name: (p.displayName?.text ?? '').trim() || 'Park',
        lat,
        lng,
        placeId: p.id ?? null,
        googleMapsUri: readGoogleMapsUri(p as RawPlaceRow & Record<string, unknown>),
        primaryType,
        distanceKm: haversineKm(center, { lat, lng }),
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const best = mapped[0];
  if (!best) return { candidate: null, placesCallsMade };
  return {
    candidate: {
      name: best.name,
      lat: best.lat,
      lng: best.lng,
      placeId: best.placeId,
      googleMapsUri: best.googleMapsUri,
      primaryType: best.primaryType,
    },
    placesCallsMade,
  };
}
