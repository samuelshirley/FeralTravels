import { legDateISO } from '@/lib/dates';
import { seededTripStartISO } from '@/app/api/test/seedDates';
import { CANONICAL_LEG_GEOMETRY } from './canonicalTripGeometry';

/**
 * The canonical trip, in code.
 *
 * WHY IT EXISTS. Until now nothing in this repo could build a trip with stops.
 * `seedCanonicalFixture` produced two legs and nothing else — no stops, no
 * geometry, no rest days — so every test about fuel, maps links, base days or a
 * trip long enough to edit in the middle had nothing to run against. The only
 * code that made a whole trip was `cloneTrip`, copying rows out of a trip that
 * already existed, which is why the admin test-account generator needed a
 * database with the owner's real trips in it, and why the E2E preview had to be
 * a clone of production. One missing fixture, three consequences.
 *
 * WHERE IT CAME FROM. Extracted from "August Portugal Trip"
 * (30df628c-cdb7-479b-9edd-e4ddbeb494d8) on 2026-08-28, at the owner's
 * instruction, because it is a trip a person actually planned and it exercises
 * everything at once: twelve days, six driving and six base; two countries;
 * segment grouping; real road geometry on every leg; three real Google fuel
 * stops; and — usefully — all three fuel cache states, `ready`, `none` and
 * `no_stations_found`, so the lazy-sourcing contract can be tested in every
 * branch from one seed. Regenerate with
 * `npx tsx scripts/extract-canonical-trip.ts <tripId> --apply`.
 *
 * WHAT IS DELIBERATELY NOT COPIED. Nothing that ties it to a person: no user id,
 * no chat transcript (generated instead, see `seedTranscript`), no created_at.
 *
 * NO DATE IS WRITTEN DOWN. `startISO` defaults to `seededTripStartISO()` —
 * today + 14 — and every leg date is derived from it by index, so a trip seeded
 * today and one seeded next March are both correctly in the future. This is the
 * rule `seedDates.ts` argues at length; the fixture obeys it by having no
 * calendar date in it at all. Same for the fuel cache: legs carry an AGE IN
 * HOURS, resolved against `now` at seed time, because "fresh" has to keep
 * meaning fresh.
 */

/** A stop as the fixture stores it — the columns a seeded stop actually needs. */
export interface CanonicalStop {
  stopType: string;
  status: string;
  name: string;
  lat: number | null;
  lng: number | null;
  distanceFromStartKm: number | null;
  source: string | null;
  googleMapsUri: string | null;
  placeId: string | null;
  fuelType: string | null;
  notes: string | null;
}

export interface CanonicalLeg {
  sortOrder: number;
  legType: string;
  title: string;
  label: string | null;
  segmentIndex: number | null;
  segmentName: string | null;
  startName: string | null;
  endName: string | null;
  startLat: number | null;
  startLng: number | null;
  endLat: number | null;
  endLng: number | null;
  distanceKm: number | null;
  driveTimeMinutes: number | null;
  terrain: string | null;
  overnight: string | null;
  status: string;
  color: string | null;
  notes: string | null;
  fuelStatus: string;
  /**
   * How long before `now` this leg's fuel cache was last written, or null for a
   * leg that was never sourced.
   *
   * An age, not a timestamp, and that is the whole point. `LegCard` re-sources
   * a leg whose cache is older than FUEL_CACHE_TTL_MS, so a fixture holding a
   * fixed date would start fresh and silently become stale — and the test that
   * asserts "a cached day does not re-search" would start passing for the wrong
   * reason, then start failing for the wrong reason. Leg 0 is deliberately
   * fresh; the other sourced legs are deliberately stale; the rest are null.
   * One seed covers all three branches.
   */
  fuelCacheAgeHours: number | null;
  stops: CanonicalStop[];
}

/** The vehicle the trip was planned against. Range is what fuel planning reads. */
export const CANONICAL_VEHICLE = {
  name: 'Hilux',
  range_km: 500,
  fuel_type: null,
} as const;

/**
 * A second profile, for the tests that swap vehicles. Deliberately SHORTER
 * ranged than the Hilux: a swap that does not change the range proves only that
 * a form saved, not that the new vehicle reached fuel planning.
 */
export const CANONICAL_ALT_VEHICLE = {
  name: 'Tacoma',
  range_km: 380,
  fuel_type: null,
} as const;

export const CANONICAL_TRIP_NAME = 'August Portugal Trip';

/**
 * The trip row's own columns — everything about the trip that is not a leg.
 *
 * These were missing from the first cut of this fixture, which is worth writing
 * down because it is the same mistake `cloneTrip` made three times: the
 * interesting data is in the child rows, so the parent's columns get forgotten,
 * and the seed produces a trip in a state the app would not have put it in.
 * `onboardingState` is the sharp one — a trip with twelve legs and
 * `not_started` shows Penny's "let's plan a trip" greeting above a finished
 * itinerary, which is exactly the incoherent fixture
 * `assertFixtureTripPossible` exists to refuse.
 */
export const CANONICAL_TRIP_META = {
  /** Legs exist and the vehicle is attached, so onboarding is behind it. */
  onboardingState: 'done',
  /** Planned, not driven. `tripStatus: 'draft'` is the user-facing lifecycle. */
  status: 'planning',
  tripStatus: 'draft',
  preferAvoidHighways: false,
  isTemplate: false,
} as const;

/**
 * DELIBERATELY NOT CARRIED, and each for its own reason:
 *
 *   - `id`, `userId`, `vehicleId`, and every child row id — a seed makes new ones.
 *   - `createdAt` / `updatedAt` — the seed happened now, not last August.
 *   - `tripNameCiKey` — derived from the name by the repo layer; deriving it
 *     twice is how the two get to disagree.
 *   - `startDateParsed` / `endDateParsed` — derived from the ISO dates, same
 *     argument.
 *   - `lastKnownLat/Lng`, `positionUpdatedAt`, `currentLegId`, `currentLat/Lng`,
 *     `progressAnchorDate`, `progressUpdatedAt` — the source trip carries a live
 *     GPS position, because it belongs to somebody who was standing in Girona
 *     when it was extracted. A fixture must not ship a person's coordinates,
 *     and a freshly seeded account has not reported a position anyway. A test
 *     that needs mid-trip progress sets it explicitly, which is also the only
 *     way that test says what it is testing.
 *   - `declaredRangeKm` / `declaredRangeLegId` / `declaredRangeAt` — a
 *     conversational override from one particular day.
 *   - The chat transcript — generated per-seed by `seedTranscript` instead. The
 *     real one is a conversation about real calendar days ("leaving on
 *     September 15th") and cloning it verbatim is the bug fixed in 732eda4.
 *   - `pendingIntent`, `onboardingScan` — mid-flight onboarding state, and this
 *     trip is past onboarding.
 */
export const CANONICAL_TRIP_NOT_CARRIED = [
  'id', 'userId', 'vehicleId', 'createdAt', 'updatedAt',
  'tripNameCiKey', 'startDateParsed', 'endDateParsed',
  'lastKnownLat', 'lastKnownLng', 'lastKnownPlace', 'positionUpdatedAt',
  'currentLegId', 'currentLat', 'currentLng', 'progressAnchorDate', 'progressUpdatedAt',
  'declaredRangeKm', 'declaredRangeLegId', 'declaredRangeAt',
  'pendingIntent', 'onboardingScan',
  'startDate', 'endDate',
] as const;

/** The twelve legs, in order. Geometry lives in the generated sibling module. */
export const CANONICAL_LEGS: readonly CanonicalLeg[] = [
  {
    sortOrder: 0, legType: "drive", title: "Girona → Burgos",
    segmentIndex: 0, segmentName: "Girona → Porto",
    startName: "Girona", endName: "Burgos",
    startLat: 41.98328, startLng: 2.82471, endLat: 42.34386, endLng: -3.6969,
    distanceKm: 612, driveTimeMinutes: 300,
    terrain: "mixed", overnight: null, status: "planning", color: null,
    notes: "[\"5-hour driving day — overnight in Burgos area\"]",
    fuelStatus: "ready", fuelCacheAgeHours: 1,
    label: null,
    stops: [
      {"stopType":"fuel","status":"option","name":"Cepsa service station","lat":41.772832,"lng":-1.2168759999999998,"distanceFromStartKm":404,"source":"google","googleMapsUri":"https://maps.google.com/?cid=9080798630375727777&g_mp=Cidnb29nbGUubWFwcy5wbGFjZXMudjEuUGxhY2VzLlNlYXJjaFRleHQQAhgEIAA","placeId":"ChIJN-4JNefXWw0RoSJmAD56BX4","fuelType":null,"notes":"Auto-suggested refuel ≈404 km into the leg."}
    ],
  },
  {
    sortOrder: 1, legType: "drive", title: "Burgos → Salamanca",
    segmentIndex: 0, segmentName: "Girona → Porto",
    startName: "Burgos", endName: "Salamanca",
    startLat: 42.34386, startLng: -3.6969, endLat: 40.9701, endLng: -5.66354,
    distanceKm: 243.9, driveTimeMinutes: 146,
    terrain: "mixed", overnight: null, status: "planning", color: null,
    notes: "[\"5-hour driving day — overnight in Salamanca\"]",
    fuelStatus: "ready", fuelCacheAgeHours: 200,
    label: null,
    stops: [],
  },
  {
    sortOrder: 2, legType: "drive", title: "Salamanca → Porto",
    segmentIndex: 0, segmentName: "Girona → Porto",
    startName: "Salamanca", endName: "Porto",
    startLat: 40.9701, startLng: -5.66354, endLat: 41.15794, endLng: -8.62911,
    distanceKm: 349.3, driveTimeMinutes: 214,
    terrain: "mixed", overnight: null, status: "planning", color: null,
    notes: "[\"Arriving Porto\"]",
    fuelStatus: "ready", fuelCacheAgeHours: 200,
    label: null,
    stops: [
      {"stopType":"fuel","status":"option","name":"Galp","lat":40.846779399999996,"lng":-6.0500023999999994,"distanceFromStartKm":37,"source":"google","googleMapsUri":"https://maps.google.com/?cid=2732039511127569119&g_mp=Cidnb29nbGUubWFwcy5wbGFjZXMudjEuUGxhY2VzLlNlYXJjaFRleHQQAhgEIAA","placeId":"ChIJA2wRWtjBPg0R3zIX3XUn6iU","fuelType":null,"notes":"Auto-suggested refuel ≈37 km into the leg."}
    ],
  },
  {
    sortOrder: 3, legType: "rest", title: "Porto (rest day)",
    segmentIndex: 0, segmentName: "Girona → Porto",
    startName: "Porto", endName: "Porto",
    startLat: 41.15794, startLng: -8.62911, endLat: 41.15794, endLng: -8.62911,
    distanceKm: null, driveTimeMinutes: null,
    terrain: null, overnight: null, status: "planning", color: null,
    notes: null,
    fuelStatus: "none", fuelCacheAgeHours: null,
    label: null,
    stops: [],
  },
  {
    sortOrder: 4, legType: "rest", title: "Porto (rest day)",
    segmentIndex: 0, segmentName: "Girona → Porto",
    startName: "Porto", endName: "Porto",
    startLat: 41.15794, startLng: -8.62911, endLat: 41.15794, endLng: -8.62911,
    distanceKm: null, driveTimeMinutes: null,
    terrain: null, overnight: null, status: "planning", color: null,
    notes: null,
    fuelStatus: "none", fuelCacheAgeHours: null,
    label: null,
    stops: [],
  },
  {
    sortOrder: 5, legType: "rest", title: "Porto (rest day)",
    segmentIndex: 0, segmentName: "Girona → Porto",
    startName: "Porto", endName: "Porto",
    startLat: 41.15794, startLng: -8.62911, endLat: 41.15794, endLng: -8.62911,
    distanceKm: null, driveTimeMinutes: null,
    terrain: null, overnight: null, status: "planning", color: null,
    notes: null,
    fuelStatus: "none", fuelCacheAgeHours: null,
    label: null,
    stops: [],
  },
  {
    sortOrder: 6, legType: "drive", title: "Porto → Lisbon",
    segmentIndex: 2, segmentName: "Porto → Lisbon",
    startName: "Porto", endName: "Lisbon",
    startLat: 41.15794, startLng: -8.62911, endLat: 38.72225, endLng: -9.13934,
    distanceKm: 315, driveTimeMinutes: 186,
    terrain: "mixed", overnight: null, status: "planning", color: null,
    notes: null,
    fuelStatus: "ready", fuelCacheAgeHours: 200,
    label: null,
    stops: [
      {"stopType":"fuel","status":"option","name":"Bombas de Gasolina Intermarché","lat":40.122862399999995,"lng":-8.5025259,"distanceFromStartKm":125,"source":"google","googleMapsUri":"https://maps.google.com/?cid=3932578603224186255&g_mp=Cidnb29nbGUubWFwcy5wbGFjZXMudjEuUGxhY2VzLlNlYXJjaFRleHQQAhgEIAA","placeId":"ChIJS7yTPWFYIg0Rj716aGdTkzY","fuelType":null,"notes":"Auto-suggested refuel ≈125 km into the leg."}
    ],
  },
  {
    sortOrder: 7, legType: "rest", title: "Lisbon (rest day)",
    segmentIndex: 2, segmentName: "Porto → Lisbon",
    startName: "Lisbon", endName: "Lisbon",
    startLat: 38.72225, startLng: -9.13934, endLat: 38.72225, endLng: -9.13934,
    distanceKm: null, driveTimeMinutes: null,
    terrain: null, overnight: null, status: "planning", color: null,
    notes: null,
    fuelStatus: "none", fuelCacheAgeHours: null,
    label: null,
    stops: [],
  },
  {
    sortOrder: 8, legType: "rest", title: "Lisbon (rest day)",
    segmentIndex: 2, segmentName: "Porto → Lisbon",
    startName: "Lisbon", endName: "Lisbon",
    startLat: 38.72225, startLng: -9.13934, endLat: 38.72225, endLng: -9.13934,
    distanceKm: null, driveTimeMinutes: null,
    terrain: null, overnight: null, status: "planning", color: null,
    notes: null,
    fuelStatus: "none", fuelCacheAgeHours: null,
    label: null,
    stops: [],
  },
  {
    sortOrder: 9, legType: "rest", title: "Lisbon (rest day)",
    segmentIndex: 2, segmentName: "Porto → Lisbon",
    startName: "Lisbon", endName: "Lisbon",
    startLat: 38.72225, startLng: -9.13934, endLat: 38.72225, endLng: -9.13934,
    distanceKm: null, driveTimeMinutes: null,
    terrain: null, overnight: null, status: "planning", color: null,
    notes: null,
    fuelStatus: "none", fuelCacheAgeHours: null,
    label: null,
    stops: [],
  },
  {
    sortOrder: 10, legType: "drive", title: "Lisbon → Madrid area",
    segmentIndex: 3, segmentName: "Lisbon → Girona",
    startName: "Lisbon", endName: "Madrid area",
    startLat: 38.72232, startLng: -9.13934, endLat: 40.48623, endLng: -3.39709,
    distanceKm: 656.3, driveTimeMinutes: 376,
    terrain: "mixed", overnight: null, status: "planning", color: null,
    notes: null,
    fuelStatus: "none", fuelCacheAgeHours: null,
    label: null,
    stops: [],
  },
  {
    sortOrder: 11, legType: "drive", title: "Madrid area → Girona",
    segmentIndex: 3, segmentName: "Lisbon → Girona",
    startName: "Madrid area", endName: "Girona",
    startLat: 40.48623, startLng: -3.39709, endLat: 41.98328, endLng: 2.82471,
    distanceKm: 655.3, driveTimeMinutes: 376,
    terrain: "mixed", overnight: null, status: "planning", color: null,
    notes: null,
    fuelStatus: "no_stations_found", fuelCacheAgeHours: 200,
    label: null,
    stops: [],
  },
];

/** The resolved shape a seeder inserts: the fixture plus dates and geometry. */
export interface ResolvedCanonicalLeg extends CanonicalLeg {
  /** ISO date for this leg — startISO advanced by sortOrder, one day per leg. */
  date: string;
  /** Encoded polyline, decoded by the client through `decodePolyline`. */
  geometry: string | null;
  /** Absolute timestamp resolved from `fuelCacheAgeHours`, or null. */
  fuelStopsUpdatedAt: Date | null;
}

export interface ResolvedCanonicalTrip {
  name: string;
  startISO: string;
  endISO: string;
  legs: ResolvedCanonicalLeg[];
  meta: typeof CANONICAL_TRIP_META;
}

/**
 * Resolve the fixture against a moment: dates from `startISO`, cache stamps from
 * `now`.
 *
 * Both parameters exist so a test can describe a moment rather than wait for
 * one — the same reason `seededTripStartISO` takes a `now`.
 */
export function resolveCanonicalTrip(
  startISO: string = seededTripStartISO(),
  now: Date = new Date()
): ResolvedCanonicalTrip {
  const legs = CANONICAL_LEGS.map((leg) => ({
    ...leg,
    date: legDateISO(startISO, leg.sortOrder),
    geometry: CANONICAL_LEG_GEOMETRY[leg.sortOrder] ?? null,
    fuelStopsUpdatedAt:
      leg.fuelCacheAgeHours == null
        ? null
        : new Date(now.getTime() - leg.fuelCacheAgeHours * 60 * 60 * 1000),
  }));

  return {
    name: CANONICAL_TRIP_NAME,
    meta: CANONICAL_TRIP_META,
    startISO,
    // The last leg's date, not start + 12: the trip ends on the day the driver
    // gets home, and `legDateISO` is the one place that arithmetic lives.
    endISO: legDateISO(startISO, CANONICAL_LEGS.length - 1),
    legs,
  };
}

/** Total driving distance, for the tests that assert the summary. */
export const CANONICAL_TOTAL_KM = CANONICAL_LEGS.reduce((sum, l) => sum + (l.distanceKm ?? 0), 0);

/** Six and six — the split the trip summary shows. */
export const CANONICAL_DRIVING_DAYS = CANONICAL_LEGS.filter((l) => l.legType === 'drive').length;
export const CANONICAL_BASE_DAYS = CANONICAL_LEGS.filter((l) => l.legType === 'rest').length;
