import 'server-only';

/**
 * Split a long route into per-day legs anchored to real polyline points.
 *
 * Why this exists: when Penny gets back a real route from Google Directions
 * (say, 11 hours / 1100km from Girona to Berlin) and the driver's vehicle
 * has `max_drive_hours_per_day = 6`, we need to break that into multiple
 * legs each ≤ 6h. We can't ask the LLM to pick split points — it'll
 * hallucinate. Instead we walk the actual polyline accumulating distance
 * (assuming uniform speed across the route) and emit split points at the
 * 6h mark, the 12h mark, etc.
 *
 * Uniform-speed approximation: the Directions API gives us a single
 * `drive_time_minutes` for the whole route, not per-segment timings. We
 * proxy time-along-route as a linear function of distance-along-route. This
 * is wrong in detail (a mountain pass is slower per km than a motorway) but
 * close enough for trip-planning purposes — the split point lands within a
 * few miles of the "real" 6h point. The user picks their actual overnight
 * spot from there using the existing UI's "Dog parks nearby / Parks nearby"
 * Maps chips, so a few miles' imprecision in the placeholder is fine.
 *
 * If Penny ever needs sub-hour precision (bridge avoidance, ferry timing),
 * we'd switch to Routes API which can return per-step durations.
 */

import { haversineKm } from './geo';

export interface RoutePoint {
  /** [lat, lng] */
  point: [number, number];
}

export interface SplitInput {
  /** Polyline as [lat, lng] pairs, ordered from start to end of route. */
  polyline_points: Array<[number, number]>;
  /** Total distance in km from Directions. */
  total_distance_km: number;
  /** Total drive time in minutes from Directions. */
  total_drive_time_minutes: number;
  /** Vehicle's per-day driving cap, in minutes. */
  max_drive_minutes_per_day: number;
}

export interface DayLeg {
  /** 1-indexed day number within this split. */
  day_index: number;
  start_lat: number;
  start_lng: number;
  end_lat: number;
  end_lng: number;
  distance_km: number;
  drive_time_minutes: number;
  /** Fraction along the original polyline this leg's end falls at (0–1). */
  fraction_along_route: number;
}

/**
 * Split a route into N driving days each within the per-day cap.
 *
 * Returns a single-element array if the route fits in one day. Returns the
 * input unchanged (as a single leg) if the polyline is empty or the cap is
 * non-positive.
 */
export function splitLegByDriveTime(input: SplitInput): DayLeg[] {
  const {
    polyline_points,
    total_distance_km,
    total_drive_time_minutes,
    max_drive_minutes_per_day,
  } = input;

  // Defensive: if we don't have a polyline or sane caps, return a single leg
  // covering the whole thing. The caller (validator) decides whether to
  // accept that or reject.
  if (
    polyline_points.length < 2 ||
    total_drive_time_minutes <= 0 ||
    max_drive_minutes_per_day <= 0
  ) {
    if (polyline_points.length >= 2) {
      const start = polyline_points[0];
      const end = polyline_points[polyline_points.length - 1];
      return [
        {
          day_index: 1,
          start_lat: start[0],
          start_lng: start[1],
          end_lat: end[0],
          end_lng: end[1],
          distance_km: total_distance_km,
          drive_time_minutes: total_drive_time_minutes,
          fraction_along_route: 1,
        },
      ];
    }
    return [];
  }

  if (total_drive_time_minutes <= max_drive_minutes_per_day) {
    const start = polyline_points[0];
    const end = polyline_points[polyline_points.length - 1];
    return [
      {
        day_index: 1,
        start_lat: start[0],
        start_lng: start[1],
        end_lat: end[0],
        end_lng: end[1],
        distance_km: total_distance_km,
        drive_time_minutes: total_drive_time_minutes,
        fraction_along_route: 1,
      },
    ];
  }

  // Build cumulative distance along the polyline, then convert to time using
  // the uniform-speed proxy. cumulativeKm[i] = total km from points[0] to
  // points[i].
  const cumulativeKm: number[] = new Array(polyline_points.length).fill(0);
  for (let i = 1; i < polyline_points.length; i++) {
    const [lat0, lng0] = polyline_points[i - 1];
    const [lat1, lng1] = polyline_points[i];
    cumulativeKm[i] = cumulativeKm[i - 1] + haversineKm(lat0, lng0, lat1, lng1);
  }
  const polylineTotalKm = cumulativeKm[cumulativeKm.length - 1];

  // We use Google's reported total_distance_km as the truth, and the
  // polyline's haversine-summed length as a secondary signal for
  // *fractional* progress. They differ slightly because the polyline is a
  // simplified path (overview_polyline ~50–500 points).
  if (polylineTotalKm <= 0) {
    return [
      {
        day_index: 1,
        start_lat: polyline_points[0][0],
        start_lng: polyline_points[0][1],
        end_lat: polyline_points[polyline_points.length - 1][0],
        end_lng: polyline_points[polyline_points.length - 1][1],
        distance_km: total_distance_km,
        drive_time_minutes: total_drive_time_minutes,
        fraction_along_route: 1,
      },
    ];
  }

  // How many days do we need?
  const numDays = Math.ceil(total_drive_time_minutes / max_drive_minutes_per_day);
  // Distribute time evenly so the last day isn't a sliver
  // (e.g. 11h / 6h = 2 days, but emit 5.5h + 5.5h, not 6h + 5h).
  const minutesPerDay = total_drive_time_minutes / numDays;

  const legs: DayLeg[] = [];
  let prevPointIdx = 0;

  for (let d = 1; d <= numDays; d++) {
    // Target fraction of total time at the end of this day.
    const endTimeFraction = Math.min(1, (d * minutesPerDay) / total_drive_time_minutes);
    // The polyline-distance fraction we want to reach by end-of-day.
    // Uniform-speed proxy: time fraction == distance fraction.
    const targetKm = polylineTotalKm * endTimeFraction;

    // Find the first polyline point at or beyond targetKm.
    let endIdx = prevPointIdx;
    while (endIdx < cumulativeKm.length - 1 && cumulativeKm[endIdx] < targetKm) {
      endIdx++;
    }

    const dayStart = polyline_points[prevPointIdx];
    const dayEnd = polyline_points[endIdx];
    const dayKmFromPolyline = cumulativeKm[endIdx] - cumulativeKm[prevPointIdx];
    // Scale to Google's authoritative total distance.
    const distanceKm =
      Math.round(((dayKmFromPolyline / polylineTotalKm) * total_distance_km) * 10) / 10;
    const driveTimeMinutes = Math.round(minutesPerDay);

    legs.push({
      day_index: d,
      start_lat: dayStart[0],
      start_lng: dayStart[1],
      end_lat: dayEnd[0],
      end_lng: dayEnd[1],
      distance_km: distanceKm,
      drive_time_minutes: driveTimeMinutes,
      fraction_along_route: endTimeFraction,
    });

    prevPointIdx = endIdx;
  }

  return legs;
}
