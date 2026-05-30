import 'server-only';

import { haversineKm } from '../geo';

/**
 * Distance-anchoring geometry for the overnight-stop engine.
 *
 * Why distance, not time: Google's Directions ETA assumes the speed limit.
 * Real overlander speed is lower and varies by vehicle, so anchoring the
 * day's stop on *time* systematically overshoots (a "6h" estimate came out
 * to 7.5h on a real Hilux drive). Distance is speed-independent, so we walk
 * the polyline to a target *kilometre* mark — the daily reach, bounded by
 * fuel range — and search a window around it.
 *
 * Everything here is pure and deterministic (no DB, no network, no LLM). It
 * mirrors the polyline-walking already used by `split-route.ts`.
 *
 * See docs/overnight-stop-feature-scope.md for the full feature.
 */

export type LatLng = [number, number];

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface AnchorInput {
  /** Route polyline as [lat, lng] pairs, ordered start → end. */
  polyline: LatLng[];
  /**
   * How far into the drive we want to stop, km. This is the daily-reach
   * preference, already bounded by the vehicle's safe fuel range by the caller.
   */
  targetKm: number;
  /**
   * Half-width of the accepted *along-route* window, km. We'll happily stop a
   * bit early or late if there's a better spot. Default 30 km.
   */
  windowHalfWidthKm?: number;
  /**
   * Half-width of the search corridor *perpendicular* to the route, km — how
   * far off the road we'll look for a candidate. Default 3 km.
   */
  corridorHalfWidthKm?: number;
}

export interface OvernightWindow {
  /** Interpolated point at the target distance along the route. */
  anchor: LatLng;
  /** Distance along the route to the anchor, km (clamped to route length). */
  anchorKm: number;
  /** Accepted along-route distance range, km. */
  windowStartKm: number;
  windowEndKm: number;
  /** Polyline covering [windowStartKm, windowEndKm], with interpolated ends. */
  windowPolyline: LatLng[];
  /** Search box: the window polyline expanded by the corridor half-width. */
  bbox: BBox;
  /** Total haversine length of the supplied polyline, km. */
  routeKm: number;
}

const DEFAULT_WINDOW_HALF_WIDTH_KM = 30;
const DEFAULT_CORRIDOR_HALF_WIDTH_KM = 3;

/** Km per degree of latitude (mean). */
const KM_PER_DEG_LAT = 110.574;
/** Km per degree of longitude at the equator; scaled by cos(lat). */
const KM_PER_DEG_LNG_EQUATOR = 111.32;

/** Cumulative haversine distance from points[0] to points[i], km. */
function cumulativeKm(points: LatLng[]): number[] {
  const cum = new Array<number>(points.length).fill(0);
  for (let i = 1; i < points.length; i++) {
    const [lat0, lng0] = points[i - 1];
    const [lat1, lng1] = points[i];
    cum[i] = cum[i - 1] + haversineKm(lat0, lng0, lat1, lng1);
  }
  return cum;
}

/** Linearly interpolate the point at `km` along the polyline. */
function interpolateAt(points: LatLng[], cum: number[], km: number): LatLng {
  const total = cum[cum.length - 1];
  if (km <= 0) return points[0];
  if (km >= total) return points[points.length - 1];

  let i = 1;
  while (i < cum.length && cum[i] < km) i++;
  // Now cum[i-1] <= km <= cum[i].
  const segLen = cum[i] - cum[i - 1];
  const t = segLen > 0 ? (km - cum[i - 1]) / segLen : 0;
  const [lat0, lng0] = points[i - 1];
  const [lat1, lng1] = points[i];
  return [lat0 + (lat1 - lat0) * t, lng0 + (lng1 - lng0) * t];
}

/** Sub-polyline between two along-route distances, with interpolated ends. */
function slicePolyline(
  points: LatLng[],
  cum: number[],
  startKm: number,
  endKm: number
): LatLng[] {
  const out: LatLng[] = [interpolateAt(points, cum, startKm)];
  for (let i = 0; i < points.length; i++) {
    if (cum[i] > startKm && cum[i] < endKm) out.push(points[i]);
  }
  out.push(interpolateAt(points, cum, endKm));
  return out;
}

/** Axis-aligned bbox over the points, padded by `padKm` in every direction. */
function bboxAround(points: LatLng[], padKm: number): BBox {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const [lat, lng] of points) {
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
  }
  const midLat = (south + north) / 2;
  const latPad = padKm / KM_PER_DEG_LAT;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  // Guard against the poles where cos→0; clamp the divisor.
  const lngPad = padKm / (KM_PER_DEG_LNG_EQUATOR * Math.max(0.01, Math.abs(cosLat)));
  return {
    south: south - latPad,
    west: west - lngPad,
    north: north + latPad,
    east: east + lngPad,
  };
}

/**
 * Compute the overnight search window for a route.
 *
 * Throws on invalid input (empty/degenerate polyline, non-positive target) —
 * callers validate first; we never silently return a wrong answer.
 */
export function computeOvernightWindow(input: AnchorInput): OvernightWindow {
  const { polyline, targetKm } = input;
  const windowHalfWidthKm = input.windowHalfWidthKm ?? DEFAULT_WINDOW_HALF_WIDTH_KM;
  const corridorHalfWidthKm =
    input.corridorHalfWidthKm ?? DEFAULT_CORRIDOR_HALF_WIDTH_KM;

  if (polyline.length < 2) {
    throw new Error('computeOvernightWindow: polyline needs at least 2 points');
  }
  if (!(targetKm > 0)) {
    throw new Error('computeOvernightWindow: targetKm must be positive');
  }

  const cum = cumulativeKm(polyline);
  const routeKm = cum[cum.length - 1];
  if (!(routeKm > 0)) {
    throw new Error('computeOvernightWindow: route has zero length');
  }

  const anchorKm = Math.min(targetKm, routeKm);
  const windowStartKm = Math.max(0, anchorKm - windowHalfWidthKm);
  const windowEndKm = Math.min(routeKm, anchorKm + windowHalfWidthKm);

  const anchor = interpolateAt(polyline, cum, anchorKm);
  const windowPolyline = slicePolyline(polyline, cum, windowStartKm, windowEndKm);
  const bbox = bboxAround(windowPolyline, corridorHalfWidthKm);

  return {
    anchor,
    anchorKm,
    windowStartKm,
    windowEndKm,
    windowPolyline,
    bbox,
    routeKm,
  };
}
