/**
 * Google / OSRM polyline algorithm (precision 5, the OSRM default).
 *
 * We own this tiny decoder so the server can plan fuel stops without
 * pulling `@mapbox/polyline` (an extra dep + a CJS/ESM headache inside
 * Next's route handlers). Round-trip verified against OSRM's own
 * encoded polylines for the trips we ship with.
 *
 * Reference: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */

/** One point on a route. */
export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Decode an OSRM / Google-precision-5 polyline into `[lat, lng]` pairs.
 *
 * Falls back to an empty array on malformed input (e.g. truncated strings,
 * accidentally URL-decoded twice) rather than throwing — the caller handles
 * "couldn't plan fuel stops" once, and a decode failure just becomes
 * another instance of that path.
 */
export function decodePolyline(encoded: string): LatLng[] {
  if (!encoded) return [];
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;

    // Latitude delta.
    do {
      byte = encoded.charCodeAt(index++) - 63;
      if (Number.isNaN(byte)) return points; // truncated
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    const dLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dLat;

    // Longitude delta.
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      if (Number.isNaN(byte)) return points; // truncated mid-point
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    const dLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dLng;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return points;
}

/**
 * Great-circle distance in kilometers using the Haversine formula.
 * Accurate to ~0.5% for driving distances — plenty for "where along the
 * route are we" math where we're ultimately snapping to a gas station.
 */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371; // km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Walk a polyline and emit a coordinate every `targetKm` cumulative km.
 * Used by the fuel planner: if the vehicle's effective range is 600 km,
 * we ask for a sample every ~500 km (range × some fraction) and those
 * samples become the search centers for Google Places.
 *
 * `firstTargetKm` lets the caller offset the first sample (used by the
 * fuel planner to place an early stop when entering a leg with a
 * partially-empty tank from previous legs). Subsequent samples space at
 * `targetKm` because the tank is assumed full again after the first stop.
 *
 * Linear interpolation between the two straddling vertices so we don't
 * artificially round up to the next polyline segment (which for long
 * highway stretches can skip a whole town).
 *
 * Returns samples including their along-route distance so callers can
 * label the resulting stops with `distance_from_start_km`.
 */
export interface SampledPoint {
  point: LatLng;
  distance_km: number; // cumulative along the polyline
}

export function samplePolylineEveryKm(
  polyline: LatLng[],
  targetKm: number,
  firstTargetKm: number = targetKm
): SampledPoint[] {
  if (polyline.length < 2 || targetKm <= 0) return [];

  const out: SampledPoint[] = [];
  let cumulative = 0;
  // Clamp firstTargetKm: caller might pass <=0 if the vehicle entered the
  // leg already over-range. In that case, sample at the very start (km 0)
  // and then space normally — the alternative (negative offset) breaks the
  // while-loop math below.
  let nextTarget = firstTargetKm > 0 ? firstTargetKm : 0;

  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1];
    const b = polyline[i];
    const segment = haversineKm(a, b);
    if (segment === 0) continue;

    // Consume any targets that fall inside [cumulative, cumulative+segment].
    while (nextTarget <= cumulative + segment) {
      const excess = nextTarget - cumulative;
      const t = excess / segment; // 0..1
      out.push({
        point: {
          lat: a.lat + (b.lat - a.lat) * t,
          lng: a.lng + (b.lng - a.lng) * t,
        },
        distance_km: nextTarget,
      });
      nextTarget += targetKm;
    }

    cumulative += segment;
  }

  return out;
}

/**
 * Total polyline length in km — used to sanity-check that OSRM's reported
 * distance matches what the geometry actually describes (mismatches happen
 * when the geometry got truncated or when distance was `0` from a stub
 * route).
 */
export function polylineLengthKm(polyline: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < polyline.length; i++) {
    total += haversineKm(polyline[i - 1], polyline[i]);
  }
  return total;
}

/**
 * Encode a polyline into Google's "Encoded Polyline Algorithm Format".
 * Inverse of `decodePolyline`. Used to hand a route to the Places
 * search-along-route request (which takes an encoded polyline).
 * https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function encodePolyline(points: LatLng[]): string {
  let lastLat = 0;
  let lastLng = 0;
  let out = '';

  const encodeSigned = (value: number): string => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let chunk = '';
    while (v >= 0x20) {
      chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    chunk += String.fromCharCode(v + 63);
    return chunk;
  };

  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    out += encodeSigned(lat - lastLat);
    out += encodeSigned(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return out;
}
