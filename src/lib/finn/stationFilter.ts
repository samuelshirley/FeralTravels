/**
 * Finn station eligibility filter — drop fuel stations a passenger / overland
 * vehicle can't (or shouldn't) use. Pure + tag-light; runs over the
 * `FuelStation` rows from the Google Places corridor BEFORE range placement.
 *
 * Why this exists: a bare "gas station" search can surface truck-only stops
 * ("St1 Truck", "ESSO Truckstop") — card-only, diesel-only, no normal pumps.
 * Routing a normal vehicle there is the "CarPlay sent me to a truckstop"
 * failure Sam hit.
 *
 * Data-source note: the old OSM source exposed `access=*` and `fuel:*` tags,
 * which let us catch private fleet pumps and diesel-only forecourts. Google
 * Places (New) exposes neither, so those two defenses are gone (accepted
 * regression at the Google cutover). What remains works on Google data: the
 * name/brand truck marker regex, and Google's own `truck_stop` place type.
 *
 * Safety bias — KEEP when unsure. Excluding a usable station can route the
 * driver into a fuel gap, a worse failure than one annoying truck stop. So we
 * only reject on *positive evidence* of a truck stop, never on missing data.
 */

import type { FuelStation } from '@/lib/google/places';

export type StationRejectionReason = 'truck_only';

export interface StationEligibility {
  usable: boolean;
  reason?: StationRejectionReason;
  /** Human one-liner for logs / the debug endpoint. */
  detail?: string;
}

/**
 * Name/brand markers for truck-only stations across the languages we route in.
 * Word-boundary anchored so it catches "St1 Truck" / "ESSO Truckstop" / "LKW"
 * but NOT substrings like the town "Truckee" (no boundary after "truck").
 * `lkw` = truck (DE), `camion` = truck (FR/ES/IT).
 */
const TRUCK_NAME_RE = /\b(trucks?|truckstop|truckpark\w*|lkw|camion)\b/i;

/**
 * Classify a single station. Order: Google's explicit `truck_stop` type is the
 * hardest signal, then the name/brand marker.
 */
export function classifyStation(station: FuelStation): StationEligibility {
  // 1. Google's own place type. A place typed `truck_stop` but NOT also
  //    `gas_station` is a dedicated truck stop — skip it. (Many normal
  //    forecourts carry both types; those stay.)
  const types = station.types ?? [];
  if (types.includes('truck_stop') && !types.includes('gas_station')) {
    return { usable: false, reason: 'truck_only', detail: 'Google type=truck_stop' };
  }

  // 2. Explicit truck naming (e.g. "St1 Truck", "ESSO Truckstop").
  const nameHay = `${station.name ?? ''} ${station.brand ?? ''}`;
  if (TRUCK_NAME_RE.test(nameHay)) {
    return {
      usable: false,
      reason: 'truck_only',
      detail: `name/brand matches truck marker: "${nameHay.trim()}"`,
    };
  }

  return { usable: true };
}

export interface StationFilterResult {
  kept: FuelStation[];
  rejected: Array<{ station: FuelStation; eligibility: StationEligibility }>;
}

/**
 * Partition a corridor's stations into the ones Finn may route to and the ones
 * it must skip, keeping the rejection reason for logging / the debug endpoint.
 */
export function filterUsableStations(stations: FuelStation[]): StationFilterResult {
  const kept: FuelStation[] = [];
  const rejected: StationFilterResult['rejected'] = [];
  for (const station of stations) {
    const eligibility = classifyStation(station);
    if (eligibility.usable) kept.push(station);
    else rejected.push({ station, eligibility });
  }
  return { kept, rejected };
}
