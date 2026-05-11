import 'server-only';
import { and, asc, desc, eq, lt, like, or } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { legs, stops } from '@/server/db/schema';
import { getDirections } from '@/lib/directions';
import {
  decodePolyline,
  haversineKm,
  polylineLengthKm,
  samplePolylineEveryKm,
  type LatLng,
} from '@/lib/polyline';
import {
  mergeFuelAndStretchSamples,
  samplePolylineByTargetMinutes,
  type SampledPoint,
} from '@/lib/polyline-time';
import { nearestStretchBreakPlace, type StretchBreakCandidate } from '@/server/places/nearby-parks';
import { computeEffectiveRangeKm } from '@/lib/penny/context';
import { getVehicleForUser, getDefaultVehicleForUser } from '@/server/repos/vehicles';
import { logGooglePlacesUsage } from '@/server/repos/usage';
import { googleMapsApiKeyForServer } from '@/server/google-maps-server-key';

/**
 * Auto fuel-stop planner.
 *
 * Flow for a leg that has start + end coords and a vehicle on file:
 *   1. Fetch OSRM polyline for start→end.
 *   2. Sample it every (range × SAMPLE_FRACTION) km — this is how far we
 *      comfortably want to push between fill-ups, given the 20% reserve.
 *   3. For each sample, call Google Places Nearby Search (radius =
 *      SEARCH_RADIUS_KM) filtered to gas_station.
 *   4. Pick the best candidate (nearest to the sample point that matches
 *      the vehicle's fuel type keyword when possible).
 *   5. Replace any previous auto-generated fuel stops on the leg (source
 *      = 'google_places', status='option'), plus matching auto **rest**
 *      stretch breaks (same source/status, notes prefix
 *      AUTO_STRETCH_BREAK_NOTE_PREFIX). User-picked / user-authored stops
 *      are never touched.
 *
 *   Stretch knots: when vehicle.max_drive_hours_per_day is set, sample the
 *   polyline at ~80 % of that cap in estimated driving time (uniform-speed
 *   proxy from OSRM), merge with fuel samples, dedupe clusters, Places
 *   dog_park/park lookup at stretch-only knots; fuel+stretch clusters get
 *   fuel only so the station doubles as the break where possible.
 *
 * Fails loudly (sets fuel_status='failed', fuel_plan_error text, returns
 * details) when the Places key is missing, the vehicle has no range data, the
 * route couldn't be decoded, or Places returns an error. Prefer
 * GOOGLE_MAPS_SERVER_API_KEY for server REST calls (see google-maps-server-key).
 * The UI reads fuel_status / fuel_plan_error for spinners and accurate copy.
 */

// Walk between refuels is a fraction of effective_range_km so we always
// leave a safety margin on top of the 20% tank reserve built into
// effective_range_km. 0.85 → at range=600km, we plan a stop ~every 510km.
const SAMPLE_FRACTION = 0.85;
// Google Places Nearby Search radius, meters. Big enough to find a station
// in a rural stretch, small enough to stay on-route (a 10km detour feels
// acceptable on a long drive).
const SEARCH_RADIUS_KM = 10;
// Hard cap on how many fuel stops we'll propose per leg. Prevents a
// 5000km leg from spawning 10+ "option" rows that clutter the UI.
const MAX_STOPS_PER_LEG = 8;
// Minimum leg length to bother planning at all. Under this, the vehicle's
// original tank + reserve almost certainly covers the drive.
const MIN_LEG_KM_FOR_PLANNING = 100;
// Carry-over allowance: if the cumulative km since last refuel + this
// leg's distance is under range × this, we skip planning entirely.
// Same semantics as the original 0.7 isolation threshold but applied to
// the *cumulative* distance instead of the leg's distance, which is what
// fixes the "three 500 km legs say no fuel needed" bug.
const SKIP_PLANNING_THRESHOLD = 0.7;
// When placing stretch-break knots, target ~80% of max_drive_hours_per_day in
// estimated driving time so detours to dog parks / fuel rarely exceed the cap.
const SEGMENT_TIME_BUFFER = 0.2;
// Merge fuel-range and time-based knots when they land within this along-route gap (km).
const KNOT_MERGE_GAP_KM = 12;
/** Matches auto-inserted rest rows — used when clearing planner output. */
export const AUTO_STRETCH_BREAK_NOTE_PREFIX = 'Auto-suggested stretch break';

export interface FuelPlanResult {
  legId: number;
  status: 'ready' | 'failed' | 'skipped';
  reason?: string;
  stopsCreated?: number;
}

/** Quick status mutation; clears `fuel_plan_error` whenever status is not failed. */
async function setFuelStatus(
  legId: number,
  status: 'none' | 'pending' | 'computing' | 'ready' | 'failed',
  fuelPlanError: string | null = null
) {
  const errCol = status === 'failed' ? (fuelPlanError ?? 'Fuel planning failed.') : null;
  await db
    .update(legs)
    .set({ fuelStatus: status, fuelPlanError: errCol, updatedAt: new Date() })
    .where(eq(legs.id, legId));
}

/**
 * Main entry point — idempotent, safe to call repeatedly. Caller should
 * already have authorized `userId` against the leg's trip.
 */
export async function planFuelStopsForLeg(
  legId: number,
  userId: string
): Promise<FuelPlanResult> {
  // 1. Load leg + its trip so we know which vehicle to use.
  const rows = await db
    .select({
      leg: legs,
    })
    .from(legs)
    .where(eq(legs.id, legId))
    .limit(1);
  if (rows.length === 0) {
    return { legId, status: 'failed', reason: 'Leg not found' };
  }
  const leg = rows[0].leg;
  if (
    leg.startLat == null ||
    leg.startLng == null ||
    leg.endLat == null ||
    leg.endLng == null
  ) {
    // Flag as 'none' not 'failed' — this leg just doesn't have enough
    // info yet. The UI shouldn't nag the user; Penny's start/end write
    // will trigger planning on the next PATCH anyway.
    await setFuelStatus(legId, 'none');
    return { legId, status: 'skipped', reason: 'Missing leg coordinates' };
  }

  await setFuelStatus(legId, 'computing');

  // 2. Resolve the vehicle for this trip. Falls back to the user's
  //    default so Penny's draft trips without an explicit vehicle still
  //    get fuel plans.
  const vehicle = await resolveVehicleForTrip(leg.tripId, userId);
  if (!vehicle) {
    const reason = 'No vehicle on file for user';
    await setFuelStatus(legId, 'failed', reason);
    return { legId, status: 'failed', reason };
  }
  const range = computeEffectiveRangeKm(vehicle.refill_distance_km);
  if (!range) {
    const reason =
      'Vehicle is missing a refill distance. Open Settings → Vehicle profile and tell Penny how far you want to drive between fuel stops.';
    await setFuelStatus(legId, 'failed', reason);
    return { legId, status: 'failed', reason };
  }

  const placesKey = googleMapsApiKeyForServer();
  if (!placesKey) {
    const reason =
      'Missing Google Maps API key for server Places calls. Set GOOGLE_MAPS_SERVER_API_KEY (no HTTP referrer restriction) and/or NEXT_PUBLIC_GOOGLE_MAPS_API_KEY in the server environment.';
    await setFuelStatus(legId, 'failed', reason);
    return { legId, status: 'failed', reason };
  }

  // 3. OSRM call. We ask for the full polyline (vs just distance) so we
  //    can sample along it.
  const directions = await getDirections(
    leg.startLat,
    leg.startLng,
    leg.endLat,
    leg.endLng
  );
  if (!directions?.geometry) {
    const reason = 'Could not fetch route geometry';
    await setFuelStatus(legId, 'failed', reason);
    return { legId, status: 'failed', reason };
  }

  const polyline = decodePolyline(directions.geometry);
  const totalKm = polylineLengthKm(polyline);
  if (polyline.length < 2 || totalKm <= 0) {
    const reason = 'Route geometry was unusable';
    await setFuelStatus(legId, 'failed', reason);
    return { legId, status: 'failed', reason };
  }

  // Cross-leg fuel state: walk backwards through preceding legs in the
  // same trip to figure out how much range has already been consumed
  // since the last refuel. Without this, three sequential 500 km legs
  // each pass the "fits within range" check individually and the planner
  // proposes zero stops — even though the tank empties twice across them.
  const kmAlreadyBurned = await computeKmBurnedSinceLastRefuel(leg.tripId, leg.sortOrder);
  const availableRangeAtStart = Math.max(0, range - kmAlreadyBurned);

  const tripLegMeta = await db
    .select({ sortOrder: legs.sortOrder, distanceKm: legs.distanceKm })
    .from(legs)
    .where(eq(legs.tripId, leg.tripId));

  const tripLegCount = tripLegMeta.length;
  const tripTotalKm = tripLegMeta.reduce((s, r) => s + (r.distanceKm ?? 0), 0);
  const minSort =
    tripLegMeta.length > 0
      ? Math.min(...tripLegMeta.map((r) => r.sortOrder))
      : leg.sortOrder;
  const isFirstLegOfMultiLegLongTrip =
    tripLegCount > 1 && tripTotalKm > range && leg.sortOrder === minSort;

  const belowMinLeg = totalKm < MIN_LEG_KM_FOR_PLANNING;
  const cumulativeFitsComfortably =
    kmAlreadyBurned + totalKm < range * SKIP_PLANNING_THRESHOLD;

  // Early exit when the *cumulative* distance still fits within range ×
  // threshold. Short solo legs continue to skip via MIN_LEG_KM_FOR_PLANNING.
  // First leg of a multi-leg trip whose *total* distance exceeds one tank
  // still runs the planner so users see at least one suggested station on
  // long day-one segments (Maps/UI), even when tank math says leg 1 alone
  // is within range.
  if (belowMinLeg || (cumulativeFitsComfortably && !isFirstLegOfMultiLegLongTrip)) {
    await clearAutoPlannerGooglePlacesOptionStops(legId);
    await setFuelStatus(legId, 'ready');
    return { legId, status: 'ready', stopsCreated: 0 };
  }

  const stepKm = range * SAMPLE_FRACTION;
  // First sample is offset by whatever range we have left when entering
  // this leg, capped to the normal step so a fresh-tank leg behaves like
  // before. Subsequent samples space at `stepKm` because the tank is full
  // again after each fuel stop.
  let firstStepKm = Math.min(stepKm, availableRangeAtStart * SAMPLE_FRACTION);
  if (isFirstLegOfMultiLegLongTrip && cumulativeFitsComfortably) {
    // Default step lands past leg end (e.g. 600 km leg vs ~730 km first step);
    // nudge the first sample into the leg so Places runs once.
    firstStepKm = Math.min(stepKm, Math.max(40, totalKm * 0.45));
  }
  // Guard: if the computed first step would land past the leg end, no samples
  // would be generated and the planner silently returns 0 stops — even on a
  // 600 km leg with a large-tank vehicle. For any leg that is more than half
  // the effective range it's worth surfacing at least one suggested stop, so
  // cap the first step to mid-leg in that case.
  if (firstStepKm >= totalKm && totalKm > range * 0.5) {
    firstStepKm = Math.max(40, totalKm * 0.5);
  }
  const fuelSamples = samplePolylineEveryKm(polyline, stepKm, firstStepKm).slice(
    0,
    MAX_STOPS_PER_LEG
  );

  const driveMinsOsrm = directions.drive_time_minutes;
  let stretchSamples: SampledPoint[] = [];
  const maxDailyHrs = vehicle.max_drive_hours_per_day;
  if (
    maxDailyHrs != null &&
    maxDailyHrs > 0 &&
    driveMinsOsrm > maxDailyHrs * 60 * (1 - SEGMENT_TIME_BUFFER)
  ) {
    const targetSegmentMins = maxDailyHrs * 60 * (1 - SEGMENT_TIME_BUFFER);
    stretchSamples = samplePolylineByTargetMinutes(polyline, driveMinsOsrm, targetSegmentMins, {
      maxSamples: MAX_STOPS_PER_LEG,
      minDistanceFromEndKm: 10,
    });
  }

  const mergedKnots = mergeFuelAndStretchSamples(
    fuelSamples,
    stretchSamples,
    KNOT_MERGE_GAP_KM
  ).slice(0, MAX_STOPS_PER_LEG * 2);

  // Fuel type was removed from the vehicle profile in 0007 — Places filters
  // by `gas_station` includedTypes anyway, and the prior keyword-match by
  // diesel/petrol was a no-op (most stations carry both). The local var
  // stays so future fuel-type bias work has an obvious place to land.
  const fuel: null = null;
  type PendingFuel = {
    kind: 'fuel';
    distance_km: number;
    station: GasStationRanked;
    alternates: GasStationRanked[];
  };
  type PendingRest = {
    kind: 'rest';
    distance_km: number;
    place: StretchBreakCandidate;
  };

  // Tally Places API calls so we can log usage in one batched insert at the
  // end of leg planning. Tier matches the field-mask we send Google:
  //   essentials = id/displayName/location/primaryType (gas stations)
  //   pro        = essentials + googleMapsUri          (stretch-break parks)
  let placesEssentialsCalls = 0;
  let placesProCalls = 0;
  let placesError: string | null = null;

  const pending: Array<PendingFuel | PendingRest> = [];
  for (const knot of mergedKnots) {
    if (knot.needFuel) {
      const result = await findTopGasStations(knot.point, fuel, placesKey);
      placesEssentialsCalls += 1;
      if (!result.ok) {
        const reason = `${result.message} Visit /api/debug/fuel while signed in for a full diagnosis.`;
        await setFuelStatus(legId, 'failed', reason);
        console.error(
          `[fuel] userId=${userId} tripId=${leg.tripId} legId=${legId}: ${result.message}`
        );
        placesError = reason;
        await logPlacesUsageSafe({
          userId,
          tripId: leg.tripId,
          essentialsCalls: placesEssentialsCalls,
          proCalls: placesProCalls,
          success: false,
          errorMessage: placesError,
        });
        return { legId, status: 'failed', reason };
      }
      if (result.data) {
        pending.push({
          kind: 'fuel',
          distance_km: knot.distance_km,
          station: result.data.primary,
          alternates: result.data.alternates,
        });
      }
    } else if (knot.needStretch) {
      const lookup = await nearestStretchBreakPlace(knot.point, placesKey);
      placesProCalls += lookup.placesCallsMade;
      if (lookup.candidate) {
        pending.push({ kind: 'rest', distance_km: knot.distance_km, place: lookup.candidate });
      }
    }
  }

  await logPlacesUsageSafe({
    userId,
    tripId: leg.tripId,
    essentialsCalls: placesEssentialsCalls,
    proCalls: placesProCalls,
    success: true,
  });

  pending.sort((a, b) => a.distance_km - b.distance_km);

  const maxDailyLabel =
    vehicle.max_drive_hours_per_day != null && vehicle.max_drive_hours_per_day > 0
      ? String(vehicle.max_drive_hours_per_day)
      : '?';

  // 5. Replace previous auto fuel + planner stretch stops. Transactional delete+insert
  //    so the UI never sees a half-applied plan.
  //
  //    Bug 2b dedupe: a google_places stop the user previously promoted to
  //    'selected' is NOT deleted by autoPlannerGooglePlacesOptionSql (it
  //    only matches status='option'). Without the skip below, the next
  //    replan would insert a duplicate option for the same Google station
  //    and the user would see two "Total Petrol Station ~228 km" rows at
  //    the same coordinates. We compare by place_id (extracted from
  //    sourceUrl) first, falling back to a tight haversine threshold.
  await db.transaction(async (tx) => {
    const existingSelected = await tx
      .select({
        sourceUrl: stops.sourceUrl,
        lat: stops.lat,
        lng: stops.lng,
        stopType: stops.stopType,
      })
      .from(stops)
      .where(
        and(
          eq(stops.legId, legId),
          eq(stops.source, 'google_places'),
          eq(stops.status, 'selected')
        )
      );

    await tx.delete(stops).where(autoPlannerGooglePlacesOptionSql(legId));

    let inserted = 0;
    for (let i = 0; i < pending.length; i++) {
      const row = pending[i];
      if (
        row.kind === 'fuel' &&
        matchesExistingSelected(
          'fuel',
          row.station.place_id,
          row.station.lat,
          row.station.lng,
          existingSelected
        )
      ) {
        continue;
      }
      if (
        row.kind === 'rest' &&
        matchesExistingSelected(
          'rest',
          row.place.placeId ?? null,
          row.place.lat,
          row.place.lng,
          existingSelected
        )
      ) {
        continue;
      }
      if (row.kind === 'fuel') {
        await tx.insert(stops).values({
          legId,
          sortOrder: 1000 + i,
          stopType: 'fuel',
          status: 'option',
          name: row.station.name,
          lat: row.station.lat,
          lng: row.station.lng,
          distanceFromStartKm: Math.round(row.distance_km),
          fuelType: fuel ?? null,
          source: 'google_places',
          sourceUrl: row.station.place_id
            ? `https://www.google.com/maps/place/?q=place_id:${row.station.place_id}`
            : null,
          notes: `Auto-suggested refuel ≈${Math.round(row.distance_km)} km into the leg.`,
          alternatives:
            row.alternates.length > 0
              ? row.alternates.map((a) => ({
                  name: a.name,
                  lat: a.lat,
                  lng: a.lng,
                  place_id: a.place_id,
                  distance_km: a.distance_km,
                }))
              : null,
        });
      } else {
        await tx.insert(stops).values({
          legId,
          sortOrder: 1000 + i,
          stopType: 'rest',
          status: 'option',
          name: row.place.name,
          lat: row.place.lat,
          lng: row.place.lng,
          distanceFromStartKm: Math.round(row.distance_km),
          fuelType: null,
          source: 'google_places',
          sourceUrl:
            row.place.googleMapsUri ??
            (row.place.placeId
              ? `https://www.google.com/maps/place/?q=place_id:${row.place.placeId}`
              : null),
          notes: `${AUTO_STRETCH_BREAK_NOTE_PREFIX} (targets ≤${maxDailyLabel} h driving/day, ${Math.round(SEGMENT_TIME_BUFFER * 100)}% pessimism) ≈${Math.round(row.distance_km)} km along this leg.`,
        });
      }
      inserted += 1;
    }
    void inserted; // exposed only for the return below
  });

  await setFuelStatus(legId, 'ready');
  return { legId, status: 'ready', stopsCreated: pending.length };
}

/**
 * Pull a place_id out of a google.com/maps `q=place_id:XYZ` URL we wrote
 * ourselves. Returns null if the URL is missing or doesn't match the shape.
 */
function extractPlaceIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/q=place_id:([^&]+)/);
  return m ? m[1] : null;
}

/**
 * True if a candidate matches an existing stop on the same leg by place_id
 * (preferred) or by tight haversine fallback when place_id isn't available.
 * Only same stopType rows are considered — a fuel station shouldn't dedupe
 * against a rest stop that happens to share coords.
 */
function matchesExistingSelected(
  candidateType: 'fuel' | 'rest',
  candidatePlaceId: string | null,
  candidateLat: number,
  candidateLng: number,
  existing: Array<{
    sourceUrl: string | null;
    lat: number | null;
    lng: number | null;
    stopType: string;
  }>
): boolean {
  for (const e of existing) {
    if (e.stopType !== candidateType) continue;
    const existingPlaceId = extractPlaceIdFromUrl(e.sourceUrl);
    if (
      candidatePlaceId &&
      existingPlaceId &&
      candidatePlaceId === existingPlaceId
    ) {
      return true;
    }
    // Coordinate fallback: ~80 m. Tight enough that two genuinely different
    // stations don't collide, loose enough to absorb minor place-data
    // shifts between Places revisions.
    if (e.lat != null && e.lng != null) {
      const km = haversineKm(
        { lat: candidateLat, lng: candidateLng },
        { lat: e.lat, lng: e.lng }
      );
      if (km < 0.08) return true;
    }
  }
  return false;
}

function autoPlannerGooglePlacesOptionSql(legId: number) {
  return and(
    eq(stops.legId, legId),
    eq(stops.source, 'google_places'),
    eq(stops.status, 'option'),
    or(
      eq(stops.stopType, 'fuel'),
      and(eq(stops.stopType, 'rest'), like(stops.notes, `${AUTO_STRETCH_BREAK_NOTE_PREFIX}%`))
    )
  );
}

async function clearAutoPlannerGooglePlacesOptionStops(legId: number): Promise<void> {
  await db.delete(stops).where(autoPlannerGooglePlacesOptionSql(legId));
}

/**
 * Best-effort usage logging for a leg's Google Places spend. We split the
 * tally into two rows because the field-mask tier (and therefore the per-call
 * SKU price) differs between fuel-station lookups and stretch-break lookups.
 *
 * Failures are swallowed — usage logging shouldn't take down a fuel replan.
 */
async function logPlacesUsageSafe(input: {
  userId: string;
  tripId: number | null;
  essentialsCalls: number;
  proCalls: number;
  success: boolean;
  errorMessage?: string | null;
}): Promise<void> {
  try {
    if (input.essentialsCalls > 0) {
      await logGooglePlacesUsage({
        userId: input.userId,
        tripId: input.tripId,
        endpoint: 'nearby-search-essentials',
        requests: input.essentialsCalls,
        success: input.success,
        errorMessage: input.errorMessage ?? null,
      });
    }
    if (input.proCalls > 0) {
      await logGooglePlacesUsage({
        userId: input.userId,
        tripId: input.tripId,
        endpoint: 'nearby-search-pro',
        requests: input.proCalls,
        success: input.success,
        errorMessage: input.errorMessage ?? null,
      });
    }
  } catch (err) {
    console.warn('logPlacesUsageSafe failed (continuing):', err);
  }
}

export interface ReplenishFuelStopsOptions {
  /**
   * Skip every leg whose `sort_order` is strictly less than this value.
   *
   * Use case: forward-only replan. When the user edits leg N, only legs with
   * sort_order >= N can have their fuel state affected (cumulative tank math
   * flows forward — previous legs' planning depends only on legs ahead of
   * them, never behind). Skipping the unchanged front of the trip is the
   * single biggest cost win for long itineraries.
   *
   * `planFuelStopsForLeg` still walks back through preceding legs internally
   * to compute `kmBurnedSinceLastRefuel`, so skipping their *replanning* is
   * safe even though their stops continue to influence the tank-state math.
   *
   * Omit (or pass undefined) to replan every leg.
   */
  startFromSortOrder?: number;
}

/**
 * Re-run auto fuel planning for legs on a trip in sort order (needed for
 * cumulative tank state across legs). Failures on one leg are logged; the
 * rest still run. Pass `startFromSortOrder` to skip legs ahead of an edit.
 */
export async function replenishFuelStopsForTrip(
  tripId: number,
  userId: string,
  opts: ReplenishFuelStopsOptions = {}
): Promise<void> {
  const legRows = await db
    .select({ id: legs.id, sortOrder: legs.sortOrder })
    .from(legs)
    .where(eq(legs.tripId, tripId))
    .orderBy(asc(legs.sortOrder));

  const startFrom = opts.startFromSortOrder;
  const toRun =
    typeof startFrom === 'number'
      ? legRows.filter((l) => l.sortOrder >= startFrom)
      : legRows;

  for (const row of toRun) {
    try {
      await planFuelStopsForLeg(row.id, userId);
    } catch (e) {
      console.error('replenishFuelStopsForTrip: leg', row.id, e);
    }
  }
}

async function resolveVehicleForTrip(
  tripId: number | null,
  userId: string
): Promise<{
  refill_distance_km: number | null;
  max_drive_hours_per_day: number | null;
} | null> {
  if (tripId != null) {
    // Look up the trip's vehicle_id without re-querying trips directly
    // (avoid circular import). Use db directly.
    const { trips } = await import('@/server/db/schema');
    const tripRow = await db
      .select({ vehicleId: trips.vehicleId })
      .from(trips)
      .where(eq(trips.id, tripId))
      .limit(1);
    const vehicleId = tripRow[0]?.vehicleId ?? null;
    if (vehicleId != null) {
      const v = await getVehicleForUser(userId, vehicleId).catch(() => null);
      if (v) return v;
    }
  }
  return getDefaultVehicleForUser(userId).catch(() => null);
}

/**
 * Walk back through preceding legs (by sort_order) summing distance until
 * we hit a "refuel anchor": an overnight stop at the previous leg's end,
 * a user-selected fuel stop, or the trip start. Returns the kilometers of
 * range consumed since that anchor — i.e. how much of the tank is gone
 * when this leg starts.
 *
 * Design notes:
 *
 * - **Overnight stops are treated as implicit refuels.** A driver who
 *   stops for the night almost always tops up at a station near camp.
 *   Encoding this assumption removes the need for users to manually
 *   place a fuel stop at every overnight.
 *
 * - **Both `selected` and `option` fuel stops count; `dismissed` does
 *   not.** Auto-suggested `option` rows are the planner's own plan for
 *   prior legs and we want a self-consistent multi-leg plan. If we
 *   ignored them, leg 2 would always assume leg 1's tank was untouched
 *   and propose fuel-ASAP at km 0 — wrong. The planner is idempotent for
 *   this leg only (we delete its prior auto stops before re-planning at
 *   the start of `planFuelStopsForLeg`), so there's no chicken-and-egg.
 *
 * - **`legs.distance_km` is the source of truth, not the polyline.** We
 *   don't want to OSRM-call every preceding leg here; that turns one
 *   replan into N route requests. The leg row's stored distance is what
 *   the user sees in the workspace and what every other math path uses.
 *
 * - Returns 0 for the first leg of a trip (no preceding legs).
 */
async function computeKmBurnedSinceLastRefuel(
  tripId: number,
  thisLegSortOrder: number
): Promise<number> {
  const previous = await db
    .select({
      id: legs.id,
      sortOrder: legs.sortOrder,
      distanceKm: legs.distanceKm,
    })
    .from(legs)
    .where(and(eq(legs.tripId, tripId), lt(legs.sortOrder, thisLegSortOrder)))
    .orderBy(desc(legs.sortOrder));

  if (previous.length === 0) return 0;

  let kmBurned = 0;
  for (const prev of previous) {
    // Pull this leg's stops once, in sortOrder, so we can find the last
    // user-selected fuel stop (counting from leg end) for the partial-leg
    // refuel case.
    const stopRows = await db
      .select({
        stopType: stops.stopType,
        status: stops.status,
        distanceFromStartKm: stops.distanceFromStartKm,
      })
      .from(stops)
      .where(eq(stops.legId, prev.id));

    // Latest fuel stop in the leg = most recent refuel. We count both
    // `selected` (user accepted) and `option` (planner-suggested), so the
    // multi-leg plan stays self-consistent. Only `dismissed` is ignored.
    const latestFuel = stopRows
      .filter(
        (s) =>
          s.stopType === 'fuel' &&
          s.status !== 'dismissed' &&
          s.distanceFromStartKm != null
      )
      .sort((a, b) => (b.distanceFromStartKm ?? 0) - (a.distanceFromStartKm ?? 0))[0];

    if (latestFuel?.distanceFromStartKm != null) {
      const legDist = prev.distanceKm ?? 0;
      kmBurned += Math.max(0, legDist - latestFuel.distanceFromStartKm);
      return kmBurned;
    }

    // Overnight stop at end of leg = implicit refuel anchor. We do NOT
    // add this leg's distance — the driver fueled at the camp town.
    const hasOvernight = stopRows.some(
      (s) => s.stopType === 'overnight' && s.status !== 'dismissed'
    );
    if (hasOvernight) return kmBurned;

    // Otherwise: full leg distance carries forward into the tank state.
    kmBurned += prev.distanceKm ?? 0;
  }

  return kmBurned;
}

// ---------------------------------------------------------------------------
// Google Places Nearby Search — v1 (Place Search (New)).
//
// We pick v1 over legacy because legacy Nearby Search has been tagged for
// retirement and the new endpoint's `includedTypes` filter is far tighter
// ("gas_station" only) than legacy's `type=gas_station` which leaks car
// dealers and mechanics.
// https://developers.google.com/maps/documentation/places/web-service/nearby-search

interface GasStation {
  name: string;
  lat: number;
  lng: number;
  place_id: string | null;
}

/** Up to 3 ranked candidates for one knot: the primary + up to 2 alternates. */
interface GasStationRanked extends GasStation {
  /** Haversine km from the knot center — proxy for off-route detour. */
  distance_km: number;
}

interface GasStationCandidates {
  primary: GasStationRanked;
  alternates: GasStationRanked[]; // 0..2 entries
}

/** Maximum total candidates returned per knot (1 primary + 2 alternates). */
const FUEL_CANDIDATES_PER_KNOT = 3;

const PLACES_RETRYABLE_HTTP = new Set([429, 502, 503]);
const PLACES_MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Unwrap a Places HTTP error to a string for logs and the leg error column. */
function placesErrorReason(httpStatus: number, body: string): string {
  if (httpStatus === 403) {
    if (body.includes('PERMISSION_DENIED') || body.includes('blocked')) {
      return (
        'Places API (New) returned 403 PERMISSION_DENIED — enable it (and billing) in Google Cloud Console. ' +
        'If this key is restricted to HTTP referrers, set GOOGLE_MAPS_SERVER_API_KEY to a separate key without referrer restrictions for server-side Places calls.'
      );
    }
    return (
      'Places API returned 403 — key restrictions are blocking the server. ' +
      'Use GOOGLE_MAPS_SERVER_API_KEY without HTTP referrer restrictions for Places REST calls from Vercel.'
    );
  }
  if (httpStatus === 400) {
    return `Places API returned 400 — "Places API (New)" may not be enabled for this project in Google Cloud Console.`;
  }
  return `Places API returned HTTP ${httpStatus}: ${body.slice(0, 120)}`;
}

type FindGasOutcome =
  | { ok: true; data: GasStationCandidates | null }
  | { ok: false; message: string };

async function findTopGasStations(
  center: LatLng,
  // Vehicle-level fuel type was dropped in 0007; signature kept as `null`
  // so the future fuel-type bias work has an obvious place to plug back in.
  fuelType: null,
  apiKey: string
): Promise<FindGasOutcome> {
  const payload = () =>
    JSON.stringify({
      includedTypes: ['gas_station'],
      maxResultCount: 8,
      locationRestriction: {
        circle: {
          center: { latitude: center.lat, longitude: center.lng },
          radius: SEARCH_RADIUS_KM * 1000,
        },
      },
    });

  let lastHttpMessage = 'Places nearby search failed.';

  for (let attempt = 0; attempt < PLACES_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask':
            'places.displayName,places.location,places.id,places.primaryType',
        },
        body: payload(),
      });

      const bodyText = await res.text().catch(() => '');

      if (!res.ok) {
        lastHttpMessage = placesErrorReason(res.status, bodyText);
        if (PLACES_RETRYABLE_HTTP.has(res.status) && attempt < PLACES_MAX_ATTEMPTS - 1) {
          await sleep(350 * (attempt + 1));
          continue;
        }
        console.error(`[fuel] Places API error: HTTP ${res.status} — ${lastHttpMessage}`);
        return { ok: false, message: lastHttpMessage };
      }

      const data = JSON.parse(bodyText) as {
        places?: Array<{
          id?: string;
          displayName?: { text?: string };
          location?: { latitude: number; longitude: number };
          primaryType?: string;
        }>;
      };
      const places = data.places ?? [];
      if (places.length === 0) return { ok: true, data: null };

      void fuelType;
      const ranked = places
        .map((p) => {
          const loc = p.location;
          if (!loc) return null;
          return {
            name: p.displayName?.text?.trim() || 'Gas station',
            lat: loc.latitude,
            lng: loc.longitude,
            place_id: p.id ?? null,
            distance_km: haversineKm(center, { lat: loc.latitude, lng: loc.longitude }),
          };
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => a.distance_km - b.distance_km);

      const dedupedRanked: typeof ranked = [];
      for (const cand of ranked) {
        const dup = dedupedRanked.some(
          (kept) =>
            (cand.place_id != null && kept.place_id === cand.place_id) ||
            (kept.name.toLowerCase() === cand.name.toLowerCase() &&
              haversineKm(
                { lat: kept.lat, lng: kept.lng },
                { lat: cand.lat, lng: cand.lng }
              ) < 0.03)
        );
        if (!dup) dedupedRanked.push(cand);
        if (dedupedRanked.length >= FUEL_CANDIDATES_PER_KNOT) break;
      }

      const [primary, ...alternates] = dedupedRanked;
      if (!primary) return { ok: true, data: null };
      return { ok: true, data: { primary, alternates } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < PLACES_MAX_ATTEMPTS - 1) {
        await sleep(350 * (attempt + 1));
        continue;
      }
      console.warn('[fuel] Places nearby search threw after retries:', err);
      return {
        ok: false,
        message: `Places request failed after retries (${msg}). Check network and API key configuration.`,
      };
    }
  }

  return { ok: false, message: lastHttpMessage };
}
