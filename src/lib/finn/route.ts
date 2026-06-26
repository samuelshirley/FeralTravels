/**
 * Finn route geometry — projecting a station onto the planned route.
 *
 * Given a station's coordinates and the route polyline, we need two numbers:
 *   - `alongKm`  — how far along the route its nearest point sits (drives the
 *                  reachability/comfort math in `range.ts`)
 *   - `perpKm`   — straight-line distance from the route (a cheap detour proxy
 *                  used to prefilter candidates before any real Directions call)
 *
 * Pure + dependency-light (reuses the polyline helpers). The perpendicular
 * distance is a *proxy*: the real off-route detour (via ramps/one-ways) is
 * computed only for finalists with a live routing call — see the design doc.
 */

import { haversineKm, type LatLng } from '@/lib/polyline';

const toRad = (d: number): number => (d * Math.PI) / 180;

/** Cumulative along-route distance (km) at each vertex; `[0] === 0`. */
export function cumulativeDistancesKm(polyline: LatLng[]): number[] {
  const out: number[] = new Array(polyline.length);
  out[0] = 0;
  for (let i = 1; i < polyline.length; i++) {
    out[i] = out[i - 1] + haversineKm(polyline[i - 1], polyline[i]);
  }
  return out;
}

/**
 * Closest point on segment a→b to point p, with the interpolation parameter `t`
 * (0 at a, 1 at b). Uses a local equirectangular projection centered at `a` —
 * accurate to well under 1% over the few-km scale of a single polyline segment.
 */
function closestPointOnSegment(
  p: LatLng,
  a: LatLng,
  b: LatLng
): { point: LatLng; t: number } {
  const k = Math.cos(toRad(a.lat)); // longitude foreshortening at this latitude
  const bx = (b.lng - a.lng) * k;
  const by = b.lat - a.lat;
  const px = (p.lng - a.lng) * k;
  const py = p.lat - a.lat;

  const len2 = bx * bx + by * by;
  let t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;

  return {
    point: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t },
    t,
  };
}

export interface RouteProjection {
  /** Along-route distance (km) to the nearest point on the route. */
  alongKm: number;
  /** Perpendicular straight-line distance (km) from the route — detour proxy. */
  perpKm: number;
  /** Index of the segment (vertex i-1 → i) the nearest point lies on. */
  segmentIndex: number;
}

/**
 * Project a point onto the route polyline. Returns the nearest point's
 * along-route distance and the perpendicular distance to it.
 *
 * Pass a precomputed `cumulative` (from {@link cumulativeDistancesKm}) when
 * projecting many stations against the same route to avoid recomputing it.
 */
export function projectPointOntoRoute(
  point: LatLng,
  polyline: LatLng[],
  cumulative?: number[]
): RouteProjection {
  if (polyline.length === 0) {
    throw new Error('projectPointOntoRoute: empty polyline');
  }
  if (polyline.length === 1) {
    return { alongKm: 0, perpKm: haversineKm(point, polyline[0]), segmentIndex: 0 };
  }
  const cum = cumulative ?? cumulativeDistancesKm(polyline);

  let best: RouteProjection = { alongKm: 0, perpKm: Infinity, segmentIndex: 0 };
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1];
    const b = polyline[i];
    const { point: closest } = closestPointOnSegment(point, a, b);
    const perp = haversineKm(point, closest);
    if (perp < best.perpKm) {
      best = {
        alongKm: cum[i - 1] + haversineKm(a, closest),
        perpKm: perp,
        segmentIndex: i - 1,
      };
    }
  }
  return best;
}
