import 'server-only';

/** Mean Earth radius in km, the standard value used in nav/aviation libs. */
const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance between two lat/lng points in kilometres.
 *
 * We use this for "how far along the polyline are we" math, NOT for trip
 * planning distances — those come from Google Directions. Haversine over a
 * coarse overview polyline systematically under-counts (the road wiggles
 * between sample points), but for *fractional* progress along a route it's
 * close enough.
 */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/**
 * Shortest haversine distance (km) from a point to the line segment start↔end.
 * Projects the point onto the great-circle segment using a flat lat/lng
 * approximation, clamps the projection to the endpoints, then measures.
 *
 * Good enough for corridor sanity checks ("is this stop near the leg's
 * driving line?") — NOT navigation-grade. Used by the add_stop corridor
 * validator and the same-turn new-leg fallback resolver.
 */
export function distanceToSegmentKm(
  pointLat: number,
  pointLng: number,
  startLat: number,
  startLng: number,
  endLat: number,
  endLng: number
): number {
  const segLen = haversineKm(startLat, startLng, endLat, endLng);

  // Degenerate case: start ≈ end → just return distance to that point.
  if (segLen < 1) return haversineKm(pointLat, pointLng, startLat, startLng);

  // t = clamp01( dot(point-start, end-start) / |end-start|^2 ).
  const dLat = endLat - startLat;
  const dLng = endLng - startLng;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((pointLat - startLat) * dLat + (pointLng - startLng) * dLng) /
        (dLat * dLat + dLng * dLng)
    )
  );
  const projLat = startLat + t * dLat;
  const projLng = startLng + t * dLng;

  return haversineKm(pointLat, pointLng, projLat, projLng);
}
