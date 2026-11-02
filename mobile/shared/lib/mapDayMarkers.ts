import { haversineKm } from './polyline';

/**
 * The map's day markers: one round marker per PLACE a day starts from,
 * labelled with that day's number.
 *
 * The map used to draw a bare dot at every leg's start, with nothing on it, so
 * nobody could tell which day a dot was, or a dot from a stop (Sam,
 * 2026-10-22). The rule the map now follows: circles are days, and carry the
 * day number; squares are stops, and carry a fuel pump, a pin, or a count.
 *
 * ── Why grouped by place ──────────────────────────────────────────────────
 *
 * A base (rest) day starts where the day before it ended, and the day after
 * starts there too. So "Ordesa, day 2" and "Ordesa, day 3" are the same
 * coordinate, and two numbered markers at one point show only the top one.
 * Days that start within SAME_PLACE_KM of each other share one marker whose
 * label lists them all: "2–3", or "2, 9" for a place visited twice.
 *
 * The day number is the leg's position in `legs`, which is how the itinerary
 * lists them: the server orders legs by `sort_order`, and every leg, driving
 * or rest, is one calendar day (`Leg.date_iso`).
 */

/** Close enough to be "the same place" on a map zoomed to a whole trip. */
export const SAME_PLACE_KM = 0.2;

export interface DayLegInput {
  id: string;
  start_lat: number | null;
  start_lng: number | null;
}

export interface DayStartMarker {
  /** Stable React key: the earliest leg's id. */
  key: string;
  lat: number;
  lng: number;
  /** 1-based day numbers that start here, ascending. */
  days: number[];
  /** Leg ids in the same order as `days`. */
  legIds: string[];
  /** What the marker shows: "4", "2–3", "2, 9". */
  label: string;
}

/** "1,2,3,7" -> "1–3, 7". */
export function formatDayLabel(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(', ');
}

export function dayStartMarkers(legs: readonly DayLegInput[]): DayStartMarker[] {
  const groups: Array<{ lat: number; lng: number; days: number[]; legIds: string[] }> = [];
  legs.forEach((leg, index) => {
    if (leg.start_lat == null || leg.start_lng == null) return;
    const day = index + 1;
    const start = { lat: leg.start_lat, lng: leg.start_lng };
    const here = groups.find((g) => haversineKm(g, start) <= SAME_PLACE_KM);
    if (here) {
      here.days.push(day);
      here.legIds.push(leg.id);
    } else {
      groups.push({ lat: leg.start_lat, lng: leg.start_lng, days: [day], legIds: [leg.id] });
    }
  });
  return groups.map((g) => ({
    key: g.legIds[0],
    lat: g.lat,
    lng: g.lng,
    days: g.days,
    legIds: g.legIds,
    label: formatDayLabel(g.days),
  }));
}
