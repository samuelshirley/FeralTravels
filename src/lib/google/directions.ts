import 'server-only';

import { canonicalDirectionsAvoid } from '@/lib/penny/routingAvoidMerge';

/**
 * Server-side wrapper around Google Maps Directions API.
 *
 * Why this exists: Penny used to hallucinate `distance_km` and
 * `drive_time_minutes` from her training data ("Berlin to Prague is about
 * 350km") and was wrong often enough to ruin trips — the most visible
 * failure was the 21-hour-day-2 bug. With this helper Penny calls
 * `get_route` instead of guessing, and the splitter (split-route.ts) carves
 * a long route into per-day legs anchored to real polyline points.
 *
 * Uses the classic Directions API (GET, query-string) rather than the newer
 * Routes API. Directions is simpler to call, supports the same auth (server
 * API key), and gives us everything we need: distance, duration, an encoded
 * overview polyline, and route warnings. If we ever need vehicle-aware
 * routing (truck mode, height/weight) we'll switch to Routes API per the
 * height-aware-routing future doc.
 *
 * Caching: a small in-memory LRU keyed on the (origin, destination, mode,
 * avoid) tuple. Routes between two specific lat/lngs don't change
 * minute-to-minute, and a planning conversation often re-asks for the same
 * route as Penny iterates. 24h TTL.
 */

const DIRECTIONS_BASE = 'https://maps.googleapis.com/maps/api/directions/json';

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * A point Directions can be asked to route to.
 *
 * `place_id` is Google's own opaque handle for a place, carried from
 * `resolve_place` (Places Text Search returns it on every match). When it is
 * present we send `place_id:<id>` instead of the coordinate, and that is not a
 * nicety — it is the difference between a route and a `ZERO_RESULTS`.
 *
 * WHY, with the measurement (2026-09-10, live key, Guadalupe Mountains NP →
 * Zion NP). Google's centroid for a large park is the centroid of its POLYGON,
 * which for Zion sits in roadless backcountry that Directions cannot snap to a
 * road:
 *
 *     destination=37.2982022,-113.0263005              → ZERO_RESULTS
 *     destination=place_id:ChIJ2fhEiNDqyoAR9VY2qhU6Lnw → OK, 1335.1 km, 774 min
 *
 * Big Bend's centroid happens to land near a park road, which is why half of
 * one trip planned and half of it did not, and why this went unseen for months.
 */
export interface RoutePoint extends LatLng {
  place_id?: string | null;
}

/**
 * How a point is written into the query string.
 *
 * Exported for `directions.test.ts`: this one line decides whether a national
 * park routes at all, and it is worth a test that does not need a live key.
 */
export function directionsPointParam(p: RoutePoint): string {
  return p.place_id ? `place_id:${p.place_id}` : `${p.lat},${p.lng}`;
}

export interface DirectionsOptions {
  /** Travel mode. We only do driving — this is a road-trip planner. */
  mode?: 'driving';
  /** Optional things to route around. */
  avoid?: Array<'tolls' | 'highways' | 'ferries'>;
  /** Departure time (epoch seconds). Defaults to now for traffic-aware ETAs. */
  departureTime?: number;
  /**
   * Ordered pass-through points the route must visit between origin and
   * destination (e.g. "drive over the Millau Viaduct on the way"). These bend
   * the polyline AND the distance/time — the whole point of making a waypoint
   * first-class instead of just decorating the handoff URL. Keep them in
   * along-route order (we do NOT pass optimize:true; the caller owns ordering).
   */
  waypoints?: RoutePoint[];
}

export interface DirectionsResult {
  /** Total driving distance, kilometres, rounded to 1 decimal. */
  distance_km: number;
  /** Total drive time, minutes, rounded to nearest minute. */
  drive_time_minutes: number;
  /**
   * Decoded polyline as a flat array of [lat, lng] tuples.
   *
   * Built by concatenating the per-step polylines
   * (`routes[0].legs[].steps[].polyline.points`) — full road-following
   * resolution — then Douglas-Peucker-simplified to ~25m tolerance so the
   * stored geometry stays compact while still hugging the road at street
   * zoom. We deliberately do NOT use `overview_polyline`: Google documents it
   * as an approximate *smoothed* path with a small point budget spread over
   * the whole route, which renders as multi-km straight chords cutting
   * across terrain once the map is zoomed in (the "straight lines over the
   * lake" bug). `overview_polyline` remains only as a fallback if steps are
   * ever missing. Same API response either way — no extra call, no billing
   * change.
   */
  polyline_points: Array<[number, number]>;
  /** Resolved address strings Google returned for the start/end. */
  start_address: string;
  end_address: string;
  /** Free-text warnings from Google (toll roads, ferries, etc.). */
  warnings: string[];
  /**
   * Where Directions actually STARTED and ENDED — the points it snapped our
   * request to, straight out of `routes[0].legs[]`. With waypoints the route is
   * split into one leg per segment, so these are the first leg's start and the
   * LAST leg's end, never `legs[0]` for both.
   *
   * These are the coordinates worth persisting, and harvesting them is free —
   * they are in a response we have already paid for. Routing Guadalupe → Zion
   * by `place_id:` returns `end_location {37.2336032, -112.8751275}`, and that
   * bare coordinate then routes on its own in both directions, where the
   * Places centroid we asked with does not. A leg row carries no `place_id`, so
   * without this every LATER re-route of that leg — continuity repair, the
   * replan route, Finn's geometry — would fail exactly as the first one did,
   * days later and with no user message to explain it.
   *
   * Falls back to the requested coordinate if Google omits the field, which
   * leaves the caller exactly where it stood before this existed.
   */
  start_location: LatLng;
  end_location: LatLng;
  /** Was this served from cache? Useful for cost tracking. */
  cached: boolean;
}

export type DirectionsFailure =
  | { ok: false; kind: 'no_key'; message: string }
  | { ok: false; kind: 'no_results'; message: string }
  | { ok: false; kind: 'api_error'; message: string; status?: string }
  | { ok: false; kind: 'network'; message: string };

export type DirectionsResponse =
  | ({ ok: true } & DirectionsResult)
  | DirectionsFailure;

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------

const CACHE_MAX_ENTRIES = 200;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  result: DirectionsResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * One point's contribution to the cache key.
 *
 * BOTH the coordinate and the place_id, never one or the other. A request for
 * Zion's centroid WITH its place_id and the same coordinate WITHOUT one are
 * different requests with different answers — the first routes, the second is
 * `ZERO_RESULTS` — so sharing an entry between them would serve whichever
 * happened to be asked first. Keeping the coordinate in as well means two
 * different places that somehow carried the same id cannot collide either.
 */
function pointKey(p: RoutePoint): string {
  return `${p.lat.toFixed(5)},${p.lng.toFixed(5)}@${p.place_id ?? ''}`;
}

function cacheKey(origin: RoutePoint, destination: RoutePoint, opts: DirectionsOptions): string {
  const mode = opts.mode ?? 'driving';
  const avoid = canonicalDirectionsAvoid(opts.avoid ?? []).join(',');
  const wp = (opts.waypoints ?? []).map(pointKey).join('>');
  return `${pointKey(origin)}|${pointKey(destination)}|${mode}|${avoid}|${wp}`;
}

function cacheGet(key: string): DirectionsResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  // Bump LRU recency.
  cache.delete(key);
  cache.set(key, entry);
  return entry.result;
}

function cacheSet(key: string, result: DirectionsResult): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Drop oldest (Map preserves insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Polyline decoder (Google's "Encoded Polyline Algorithm Format")
// ---------------------------------------------------------------------------

/**
 * Decode Google's encoded polyline string into [lat, lng] pairs.
 * Algorithm: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 * Inlined to avoid a dependency on @googlemaps/polyline-codec.
 */
export function decodePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    points.push([lat * 1e-5, lng * 1e-5]);
  }
  return points;
}

// ---------------------------------------------------------------------------
// Route geometry: step concatenation + simplification
// ---------------------------------------------------------------------------

/**
 * Concatenate the per-step encoded polylines of a Directions route into one
 * full-resolution [lat, lng] path.
 *
 * Each step's polyline starts where the previous step's ended, so we drop
 * the duplicated boundary point when stitching. Steps missing a polyline are
 * skipped (defensive — Google always sends them for driving routes).
 * Returns [] when there are no usable steps, letting the caller fall back to
 * `overview_polyline`.
 */
export function concatStepPolylines(
  routeLegs: Array<Record<string, any>>
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const leg of routeLegs) {
    const steps: Array<Record<string, any>> = Array.isArray(leg?.steps) ? leg.steps : [];
    for (const step of steps) {
      const encoded = step?.polyline?.points;
      if (typeof encoded !== 'string' || encoded.length === 0) continue;
      const pts = decodePolyline(encoded);
      for (const pt of pts) {
        const last = out[out.length - 1];
        // Drop the step-boundary duplicate (encoded at 1e-5 precision, so
        // exact equality is the right check — no epsilon needed).
        if (last && last[0] === pt[0] && last[1] === pt[1]) continue;
        out.push(pt);
      }
    }
  }
  return out;
}

/** Simplification tolerance for persisted route geometry, in metres. */
export const POLYLINE_SIMPLIFY_TOLERANCE_M = 25;

const EARTH_RADIUS_M = 6371000;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Douglas-Peucker polyline simplification with a tolerance in metres.
 *
 * Points are [lat, lng]. Distances use a local equirectangular projection
 * (metres per degree of longitude scaled by cos(mean latitude)) — plenty
 * accurate for a 25m tolerance at road-trip scales, and much cheaper than
 * true geodesic math. Iterative (explicit stack) so a 50k-point
 * transcontinental route can't blow the call stack.
 */
export function simplifyPolyline(
  points: Array<[number, number]>,
  toleranceMeters: number
): Array<[number, number]> {
  if (points.length <= 2 || toleranceMeters <= 0) return points;

  // Project once into local planar metres around the route's mean latitude.
  const meanLatRad =
    (points.reduce((s, p) => s + p[0], 0) / points.length) * DEG_TO_RAD;
  const mPerDegLat = EARTH_RADIUS_M * DEG_TO_RAD;
  const mPerDegLng = mPerDegLat * Math.cos(meanLatRad);
  const xy: Array<[number, number]> = points.map(([lat, lng]) => [
    lng * mPerDegLng,
    lat * mPerDegLat,
  ]);

  const tolSq = toleranceMeters * toleranceMeters;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const [x1, y1] = xy[first];
    const [x2, y2] = xy[last];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const segLenSq = dx * dx + dy * dy;

    let maxDistSq = -1;
    let maxIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = xy[i];
      let distSq: number;
      if (segLenSq === 0) {
        const ddx = px - x1;
        const ddy = py - y1;
        distSq = ddx * ddx + ddy * ddy;
      } else {
        // Perpendicular distance to the infinite line through the endpoints —
        // standard DP (endpoints of the segment are already kept).
        const cross = dx * (y1 - py) - dy * (x1 - px);
        distSq = (cross * cross) / segLenSq;
      }
      if (distSq > maxDistSq) {
        maxDistSq = distSq;
        maxIdx = i;
      }
    }

    if (maxDistSq > tolSq && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([first, maxIdx], [maxIdx, last]);
    }
  }

  const out: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) out.push(points[i]);
  }
  return out;
}

/**
 * Read a `{lat, lng}` off a Directions leg, falling back to what we asked with.
 *
 * The fallback is deliberately the request's own coordinate: if Google ever
 * stops sending the field, callers are left exactly where they stood before
 * this existed rather than holding a null they have to branch on.
 */
function snappedPoint(raw: unknown, fallback: LatLng): LatLng {
  const p = raw as { lat?: unknown; lng?: unknown } | null | undefined;
  const lat = p?.lat;
  const lng = p?.lng;
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng };
  }
  return { lat: fallback.lat, lng: fallback.lng };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The Directions query string, as a pure function.
 *
 * Split out of `getDirections` so the one decision that matters here — whether
 * a point is sent as `place_id:<id>` or as a bare coordinate — can be tested
 * without a live key, a network call or a paid request. `directions.test.ts`
 * covers origin, destination and waypoints independently, because a park that
 * only routes by place_id is a park that only routes if the field survives
 * every one of those three paths.
 */
export function buildDirectionsParams(
  origin: RoutePoint,
  destination: RoutePoint,
  options: DirectionsOptions,
  key: string,
): URLSearchParams {
  const params = new URLSearchParams({
    origin: directionsPointParam(origin),
    destination: directionsPointParam(destination),
    mode: options.mode ?? 'driving',
    key,
  });
  if (options.avoid && options.avoid.length > 0) {
    const canon = canonicalDirectionsAvoid(options.avoid);
    if (canon.length > 0) params.set('avoid', canon.join('|'));
  }
  if (options.waypoints && options.waypoints.length > 0) {
    // Pipe-separated list. `place_id:` is legal in here too, and it matters for
    // the same reason as the destination. No "optimize:true" — caller orders.
    params.set('waypoints', options.waypoints.map(directionsPointParam).join('|'));
  }
  if (options.departureTime != null) {
    params.set('departure_time', String(options.departureTime));
  }
  return params;
}

/**
 * Get a driving route between two points. Returns a structured result on
 * success, a tagged failure object on any error (so callers can distinguish
 * "no key configured" from "Google said ZERO_RESULTS" from "network blew up").
 *
 * Throws never — all errors are returned as data so the Penny tool layer can
 * forward them to Claude as `tool_result(is_error: true)` and let her retry.
 */
export async function getDirections(
  origin: RoutePoint,
  destination: RoutePoint,
  options: DirectionsOptions = {}
): Promise<DirectionsResponse> {
  // Same Google Cloud key value used by the browser map (TripMap.tsx). Next.js
  // requires the NEXT_PUBLIC_ prefix for any var that ships to the client
  // bundle, so we standardise on that one name everywhere — server code reads
  // it just fine, and 'server-only' imports prevent this file from being
  // bundled into client output regardless.
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!key) {
    return {
      ok: false,
      kind: 'no_key',
      message: 'No Google Maps API key configured. Set NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.',
    };
  }

  const ck = cacheKey(origin, destination, options);
  const hit = cacheGet(ck);
  if (hit) return { ok: true, ...hit, cached: true };

  const params = buildDirectionsParams(origin, destination, options, key);
  let res: Response;
  try {
    res = await fetch(`${DIRECTIONS_BASE}?${params.toString()}`);
  } catch (err) {
    return {
      ok: false,
      kind: 'network',
      message: `Network error contacting Directions API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      kind: 'api_error',
      message: `Directions API returned HTTP ${res.status}.`,
    };
  }

  let body: any;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      kind: 'api_error',
      message: 'Directions API returned non-JSON body.',
    };
  }

  if (body.status !== 'OK') {
    if (body.status === 'ZERO_RESULTS') {
      return {
        ok: false,
        kind: 'no_results',
        message: 'No driving route found between the supplied points.',
      };
    }
    return {
      ok: false,
      kind: 'api_error',
      message: body.error_message || `Directions API status: ${body.status}.`,
      status: body.status,
    };
  }

  const route = body.routes?.[0];
  // With waypoints Google splits the trip into one `legs[]` entry PER segment
  // (origin→wp1, wp1→wp2, …, wpN→destination). Sum across all of them — reading
  // only legs[0] would report just the first hop's distance/time, which is the
  // bug that made waypoints impossible to model. Step-polyline concatenation
  // below likewise walks ALL legs, so the geometry spans the whole route.
  const routeLegs: Array<Record<string, any>> = route?.legs ?? [];
  if (!route || routeLegs.length === 0) {
    return {
      ok: false,
      kind: 'no_results',
      message: 'Directions API returned no usable routes.',
    };
  }

  const distanceMeters = routeLegs.reduce((s, l) => s + (l.distance?.value ?? 0), 0);
  const durationSeconds = routeLegs.reduce((s, l) => s + (l.duration?.value ?? 0), 0);

  // Full-resolution road geometry from the per-step polylines, simplified to
  // ~25m so persisted GeoJSON stays compact. overview_polyline (Google's
  // smoothed low-point-budget approximation) is only a fallback — rendered
  // as-is it cuts corners across terrain at street zoom.
  const stepPoints = concatStepPolylines(routeLegs);
  const polylinePoints =
    stepPoints.length >= 2
      ? simplifyPolyline(stepPoints, POLYLINE_SIMPLIFY_TOLERANCE_M)
      : route.overview_polyline?.points
        ? decodePolyline(route.overview_polyline.points)
        : [];

  const result: DirectionsResult = {
    distance_km: Math.round(distanceMeters / 100) / 10, // metres → km, 1 decimal
    drive_time_minutes: Math.round(durationSeconds / 60),
    polyline_points: polylinePoints,
    start_address: routeLegs[0].start_address ?? '',
    end_address: routeLegs[routeLegs.length - 1].end_address ?? '',
    warnings: Array.isArray(route.warnings) ? route.warnings.filter((w: unknown) => typeof w === 'string') : [],
    // First leg's start, LAST leg's end — with waypoints there is one leg per
    // segment, and reading legs[0] for both would report the first hop's end as
    // the whole route's.
    start_location: snappedPoint(routeLegs[0]?.start_location, origin),
    end_location: snappedPoint(routeLegs[routeLegs.length - 1]?.end_location, destination),
    cached: false,
  };

  cacheSet(ck, result);
  return { ok: true, ...result };
}
