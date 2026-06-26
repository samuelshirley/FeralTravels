/**
 * Finn station eligibility filter — drop fuel stations a passenger / overland
 * vehicle can't (or shouldn't) use: truck-only HGV stations, fleet depots, and
 * private / restricted-access pumps. Pure + tag-driven; runs over the
 * `OsmFuelStation` rows from the Overpass corridor BEFORE range placement.
 *
 * Why this exists: a bare `amenity=fuel` search returns unmanned HGV diesel
 * stations (e.g. "St1 Truck") parked in industrial lots — card-only, diesel-only,
 * no normal pumps. Routing a normal vehicle there is the "CarPlay sent me to a
 * truckstop" failure Sam hit. OSM's tags let us catch these; Google Places has no
 * truck type, so this filtering is only possible on the OSM data source. See
 * docs/design/finn-fuel-agent.md.
 *
 * Safety bias — KEEP when unsure. Excluding a usable station can route the driver
 * into a fuel gap, which is a worse failure than one annoying truck stop. So we
 * only reject on *positive evidence* of truck-only / non-public, never on missing
 * tags. A plain `amenity=fuel` with no extra tags always passes.
 */

import type { OsmFuelStation } from '@/lib/osm/overpass';

export type StationRejectionReason = 'private_access' | 'truck_only';

export interface StationEligibility {
  usable: boolean;
  reason?: StationRejectionReason;
  /** Human one-liner for logs / the debug endpoint. */
  detail?: string;
}

/**
 * `access=*` values that mean "not for the general public." `customers` /
 * `employees` on a fuel node almost always means a fleet/depot pump, not a
 * retail forecourt, so they're excluded too.
 */
const PRIVATE_ACCESS = new Set([
  'private',
  'no',
  'permit',
  'military',
  'delivery',
  'customers',
  'employees',
]);

/**
 * Name/brand markers for truck-only stations across the languages we route in.
 * Word-boundary anchored so it catches "St1 Truck" / "ESSO Truckstop" / "LKW"
 * but NOT substrings like the town "Truckee" (no boundary after "truck").
 * `lkw` = truck (DE), `camion` = truck (FR/ES/IT).
 */
const TRUCK_NAME_RE = /\b(trucks?|truckstop|truckpark\w*|lkw|camion)\b/i;

const PETROL_FUEL_KEYS = [
  'fuel:octane_91',
  'fuel:octane_95',
  'fuel:octane_98',
  'fuel:octane_100',
  'fuel:e5',
  'fuel:e10',
  'fuel:e85',
  'fuel:petrol',
  'fuel:gasoline',
] as const;

const DIESEL_FUEL_KEYS = [
  'fuel:diesel',
  'fuel:diesel_B7',
  'fuel:diesel_B10',
  'fuel:GTL_diesel',
] as const;

const HGV_DIESEL_KEY = 'fuel:HGV_diesel';

function anyKeyEquals(
  tags: Record<string, string>,
  keys: readonly string[],
  value: string
): boolean {
  return keys.some((k) => tags[k] === value);
}

/**
 * Classify a single station. Order matters: access is the hardest signal, then
 * the name marker, then the diesel-only fuel composition heuristic.
 */
export function classifyStation(station: OsmFuelStation): StationEligibility {
  const { tags } = station;

  // 1. Restricted / private access — hardest signal.
  const access = tags['access'];
  if (access && PRIVATE_ACCESS.has(access)) {
    return {
      usable: false,
      reason: 'private_access',
      detail: `access=${access}`,
    };
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

  // 3. Fuel composition. Truck-only stations sell diesel (+ AdBlue) and no
  //    petrol. We require POSITIVE evidence — never exclude a station that just
  //    doesn't tag its petrol grades.
  const hasPetrolYes = anyKeyEquals(tags, PETROL_FUEL_KEYS, 'yes');
  const hasPetrolNo = anyKeyEquals(tags, PETROL_FUEL_KEYS, 'no');
  const hasDieselYes = anyKeyEquals(tags, DIESEL_FUEL_KEYS, 'yes');
  const hasHgvDiesel = tags[HGV_DIESEL_KEY] === 'yes';
  const hgvDesignated = tags['hgv'] === 'designated';

  if (!hasPetrolYes) {
    // HGV diesel offered with no petrol → truck pump.
    if (hasHgvDiesel) {
      return { usable: false, reason: 'truck_only', detail: 'HGV diesel, no petrol' };
    }
    // Diesel offered AND petrol explicitly absent → diesel-only forecourt.
    if (hasDieselYes && hasPetrolNo) {
      return { usable: false, reason: 'truck_only', detail: 'diesel-only (petrol=no)' };
    }
    // HGV-designated with no petrol → truck-oriented.
    if (hgvDesignated) {
      return { usable: false, reason: 'truck_only', detail: 'hgv=designated, no petrol' };
    }
  }

  return { usable: true };
}

export interface StationFilterResult {
  kept: OsmFuelStation[];
  rejected: Array<{ station: OsmFuelStation; eligibility: StationEligibility }>;
}

/**
 * Partition a corridor's stations into the ones Finn may route to and the ones
 * it must skip, keeping the rejection reason for logging / the debug endpoint.
 */
export function filterUsableStations(stations: OsmFuelStation[]): StationFilterResult {
  const kept: OsmFuelStation[] = [];
  const rejected: StationFilterResult['rejected'] = [];
  for (const station of stations) {
    const eligibility = classifyStation(station);
    if (eligibility.usable) kept.push(station);
    else rejected.push({ station, eligibility });
  }
  return { kept, rejected };
}
