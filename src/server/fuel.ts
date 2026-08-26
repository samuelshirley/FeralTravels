import 'server-only';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { legs, stops, trips, type GeoJSONLineString } from '@/server/db/schema';
import { getDirections } from '@/lib/google/directions';
import {
  encodePolyline,
  haversineKm,
  polylineLengthKm,
  type LatLng,
} from '@/lib/polyline';
import { normalizeRangeKm } from '@/lib/vehicleProfile';
import { FUEL_CACHE_TTL_MS } from '@/lib/fuelCache';
import {
  kmBurnedSinceLastRefuel,
  type LegFuelHistory,
} from '@/lib/penny/fuelTankState';
import { getVehicleForUser, getDefaultVehicleForUser } from '@/server/repos/vehicles';
import { logUsageEvent } from '@/server/repos/usage';
import {
  searchFuelAlongRoute,
  type FuelStation,
} from '@/lib/google/places';
import {
  filterUsableStations,
  planLegFuelStops,
  projectPointOntoRoute,
  cumulativeDistancesKm,
  type PlacementCandidate,
} from '@/lib/finn';

/**
 * Auto fuel-stop planner — **Finn** (Google Places + deterministic placement).
 *
 * Flow for a leg with start + end coords and a vehicle on file:
 *   1. Take the leg's stored Google route geometry (fresh Directions call only
 *      as a fallback when a leg has none yet).
 *   2. Query Google Places (search-along-route) for fuel stations along it.
 *   3. Drop truck stops (`stationFilter.ts`).
 *   4. Project each remaining station onto the route (along-km + detour proxy).
 *   5. Run the greedy multi-stop placer (`finn/plan.ts`): never route past the
 *      vehicle's fuel range, minimise stop count.
 *   6. Replace previous auto fuel stops (source='google', status='option').
 *      User-picked / user-authored stops are never touched.
 *
 * All data comes from the Google Maps Platform key already used for routing.
 * We persist only the Google `place_id` (ToS-storable) plus the coords/name of
 * the stop the user sees. No fuel pricing (removed at the Google cutover).
 *
 * Fails loudly (`fuel_status='failed'` + `fuel_plan_error`) when the vehicle has
 * no range data, the route can't be decoded, or the Places call errors. A
 * genuinely remote leg with no reachable station is `no_stations_found`.
 */

// Hard cap on how many fuel stops we'll propose per leg — keeps a very long leg
// from spawning a cluttered list of option rows.
const MAX_STOPS_PER_LEG = 8;
// Minimum leg length to bother planning at all. Under this, the tank almost
// certainly covers the drive.
const MIN_LEG_KM_FOR_PLANNING = 100;
// Carry-over allowance: if cumulative km since the last refuel + this leg's
// distance is under range × this, skip planning (and the Places call) entirely.
const SKIP_PLANNING_THRESHOLD = 0.7;
// Max straight-line distance a station may sit off the route to still count as
// "on the way." Caps the detour we'll ever propose.
const MAX_DETOUR_KM = 15;
// A leg whose start and end are effectively the same point (within this
// straight-line distance) is a no-op — nothing to fuel. These come from
// same-place "legs" (e.g. a stay that got modelled as a leg) and must short-
// circuit to a clean 'ready' BEFORE any routing, otherwise the geometry decodes
// to <2 points and Finn would hard-fail it with "Route geometry was unusable".
// (Was the source of ~all prod 'failed' legs.)
const TRIVIAL_LEG_KM = 0.1;

export interface FuelPlanResult {
  legId: string;
  status: 'ready' | 'failed' | 'skipped' | 'no_stations_found';
  reason?: string;
  stopsCreated?: number;
}

/**
 * Quick status mutation. Persists `fuel_plan_error` (the user-visible reason)
 * for the two states that carry one — `failed` and `no_stations_found` — and
 * clears it otherwise. `no_stations_found` is NOT a failure: planning ran
 * correctly but the route is genuinely too remote for an on-route station.
 */
async function setFuelStatus(
  legId: string,
  status: 'none' | 'pending' | 'computing' | 'ready' | 'failed' | 'no_stations_found',
  fuelPlanError: string | null = null
) {
  const carriesReason = status === 'failed' || status === 'no_stations_found';
  const errCol = carriesReason
    ? (fuelPlanError ?? (status === 'failed' ? 'Fuel planning failed.' : 'No fuel stations found near the planned refuel point.'))
    : null;
  const set: Record<string, unknown> = {
    fuelStatus: status,
    fuelPlanError: errCol,
    updatedAt: new Date(),
  };
  // Cache bookkeeping for the lazy day-open loader:
  //  - a completed real search (`ready` / `no_stations_found`) stamps the cache
  //    so reopening the day within FUEL_CACHE_TTL_MS is a zero-network cache hit.
  //  - `none` is the invalidation state — clear the stamp so the next open
  //    re-searches. `failed` is left unstamped on purpose (no fresh cache → the
  //    leg keeps retrying on the next open / edit).
  if (status === 'ready' || status === 'no_stations_found') {
    set.fuelStopsUpdatedAt = new Date();
  } else if (status === 'none') {
    set.fuelStopsUpdatedAt = null;
  }
  await db.update(legs).set(set).where(eq(legs.id, legId));
}

/**
 * Mark a leg's fuel plan as failed AND record it to `usage_events` (provider
 * `finn:fuel-plan`, success=false) so the failure shows up in the admin error
 * log. Before the Google→OSM cutover, Places failures were logged via
 * `recordGooglePlacesUsage`; Finn's failures wrote only to `legs.fuel_plan_error`
 * and were invisible to /admin/errors. This restores that visibility.
 */
async function failLeg(
  legId: string,
  tripId: string | null,
  userId: string,
  reason: string
): Promise<FuelPlanResult> {
  await setFuelStatus(legId, 'failed', reason);
  await logUsageEvent({
    userId,
    tripId,
    provider: 'finn:fuel-plan',
    success: false,
    errorMessage: reason,
  }).catch((e) => console.error('[finn] failed to log fuel failure to usage_events:', e));
  return { legId, status: 'failed', reason };
}

/** Single-destination Google Maps link built from coords (fallback when a place has no googleMapsUri). */
function mapsCoordUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/** Convert a stored GeoJSON LineString (lng,lat order) to LatLng[]. */
function geometryToLatLngs(geom: GeoJSONLineString | null): LatLng[] {
  if (!geom || !Array.isArray(geom.coordinates)) return [];
  const out: LatLng[] = [];
  for (const c of geom.coordinates) {
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
      out.push({ lat: c[1], lng: c[0] });
    }
  }
  return out;
}

/**
 * Main entry point — idempotent, safe to call repeatedly. Caller should already
 * have authorized `userId` against the leg's trip.
 */
export async function planFuelStopsForLeg(
  legId: string,
  userId: string
): Promise<FuelPlanResult> {
  // 1. Load leg + its trip so we know which vehicle to use.
  const rows = await db
    .select({ leg: legs })
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
    // Not enough info yet — Penny's start/end write will trigger planning on the
    // next PATCH. Flag 'none' (not 'failed') so the UI doesn't nag.
    await setFuelStatus(legId, 'none');
    return { legId, status: 'skipped', reason: 'Missing leg coordinates' };
  }

  // Trivial (same-place) leg: start ≈ end. Nothing to fuel. Short-circuit to a
  // clean 'ready' BEFORE routing — a zero-distance route decodes to <2 points and
  // would otherwise hard-fail as "Route geometry was unusable". This was the
  // source of essentially every 'failed' leg in prod.
  if (haversineKm(
    { lat: leg.startLat, lng: leg.startLng },
    { lat: leg.endLat, lng: leg.endLng }
  ) < TRIVIAL_LEG_KM) {
    await clearAutoPlannerOptionStops(legId);
    await setFuelStatus(legId, 'ready');
    return { legId, status: 'ready', stopsCreated: 0 };
  }

  await setFuelStatus(legId, 'computing');

  // 2. Resolve the vehicle for this trip (falls back to the user's default).
  const vehicle = await resolveVehicleForTrip(leg.tripId, userId);
  if (!vehicle) {
    return failLeg(legId, leg.tripId, userId, 'No vehicle on file for user');
  }
  const range = normalizeRangeKm(vehicle.range_km);
  if (!range) {
    return failLeg(
      legId,
      leg.tripId,
      userId,
      'Vehicle is missing a refill distance. Open Settings → Vehicle profile and tell Penny how far you want to drive between fuel stops.'
    );
  }
  // 3. Route geometry to project stations onto. Prefer the leg's already-stored
  //    Google geometry — zero extra API calls, and the fuel plan then matches
  //    the exact route drawn on the map. Fall back to a fresh Directions call
  //    only when a leg has no stored geometry yet.
  let polyline = geometryToLatLngs(leg.geometry);
  if (polyline.length < 2) {
    const directions = await getDirections(
      { lat: leg.startLat, lng: leg.startLng },
      { lat: leg.endLat, lng: leg.endLng }
    );
    if (!directions.ok) {
      return failLeg(
        legId,
        leg.tripId,
        userId,
        `Could not fetch route geometry: ${directions.message}`
      );
    }
    polyline = directions.polyline_points.map(([lat, lng]) => ({ lat, lng }));
  }
  const totalKm = polylineLengthKm(polyline);
  if (polyline.length < 2 || totalKm <= 0) {
    return failLeg(legId, leg.tripId, userId, 'Route geometry was unusable');
  }

  // Cross-leg fuel state: how much range is already gone when this leg starts.
  // Without this, three sequential 500 km legs each pass the "fits within range"
  // check individually and zero stops get proposed even though the tank empties.
  //
  // The driver's declared tank state (the `declare_fuel_state` Penny tool —
  // "I only have ~150 km in the tank") overrides the default "full tank at
  // trip start" baseline at its anchor leg. Without it, Finn placed a stop at
  // 181 km for a driver who said they'd run dry at 150 (trip d0b5741b).
  const declaredAnchor = await resolveDeclaredTankAnchor(leg.tripId, range);
  const kmAlreadyBurned =
    declaredAnchor && declaredAnchor.legId === leg.id
      ? declaredAnchor.burnedKm
      : await computeKmBurnedSinceLastRefuel(leg.tripId, leg.sortOrder, declaredAnchor);

  const belowMinLeg = totalKm < MIN_LEG_KM_FOR_PLANNING;
  const cumulativeFitsComfortably =
    kmAlreadyBurned + totalKm < range * SKIP_PLANNING_THRESHOLD;

  // Early exit (and skip the Places call) when no stop can be needed.
  if (belowMinLeg || cumulativeFitsComfortably) {
    await clearAutoPlannerOptionStops(legId);
    await setFuelStatus(legId, 'ready');
    return { legId, status: 'ready', stopsCreated: 0 };
  }

  // 4. Google Places corridor → eligibility filter → route projection → candidates.
  let corridor: FuelStation[];
  try {
    corridor = await searchFuelAlongRoute(encodePolyline(polyline));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = `Couldn't reach the Google station service (${msg}). This is usually transient — try again shortly.`;
    console.error(`[finn] userId=${userId} tripId=${leg.tripId} legId=${legId}: ${msg}`);
    return failLeg(legId, leg.tripId, userId, reason);
  }

  const { kept } = filterUsableStations(corridor);
  const cumulative = cumulativeDistancesKm(polyline);
  const byId = new Map<string, FuelStation>();
  const candidates: PlacementCandidate[] = [];
  for (const st of kept) {
    const proj = projectPointOntoRoute({ lat: st.lat, lng: st.lng }, polyline, cumulative);
    if (proj.perpKm > MAX_DETOUR_KM) continue;
    byId.set(st.placeId, st);
    candidates.push({
      id: st.placeId,
      alongKm: proj.alongKm,
      detourKm: proj.perpKm,
    });
  }

  // 5. Deterministic greedy placement.
  const plan = planLegFuelStops({
    legLengthKm: totalKm,
    rangeKm: range,
    kmBurnedAtStart: kmAlreadyBurned,
    candidates,
  });

  if (plan.gap) {
    // A stop is needed but the candidate list is EMPTY — zero stations in the
    // whole corridor (or all filtered out). On any leg long enough to need a
    // stop that's near-certainly a data/service anomaly (Places overload,
    // truncated response), not real geography — treat it as a retryable
    // failure, NOT the cached `no_stations_found` safety warning. A false
    // "carry extra fuel" warning costs the warning its credibility exactly
    // where it matters (genuinely remote routes).
    if (candidates.length === 0) {
      return failLeg(
        legId,
        leg.tripId,
        userId,
        'No station data came back for this route — the station service likely returned an incomplete result. We\'ll retry automatically. If this route is genuinely remote, plan a fuel stop manually and carry extra fuel.'
      );
    }
    // Stations exist but none reachable before the hard ceiling — honest
    // warning, not an empty "ready" plan that looks safe. [[feedback_fuel_safety_bias]]
    const reason =
      plan.gapDetail ??
      'This leg is too remote for an auto-planned stop — carry extra fuel or plan a stop manually.';
    await clearAutoPlannerOptionStops(legId);
    await setFuelStatus(legId, 'no_stations_found', reason);
    return { legId, status: 'no_stations_found', reason, stopsCreated: 0 };
  }

  const chosen = plan.stops.slice(0, MAX_STOPS_PER_LEG);

  // 6. Replace previous auto fuel stops. Transactional delete+insert so the UI
  //    never sees a half-applied plan. A station the user promoted to 'selected'
  //    is preserved (the clear only matches status='option') and de-duped against.
  await db.transaction(async (tx) => {
    const existingSelected = await tx
      .select({ lat: stops.lat, lng: stops.lng, stopType: stops.stopType })
      .from(stops)
      .where(
        and(
          eq(stops.legId, legId),
          eq(stops.source, 'google'),
          eq(stops.status, 'selected')
        )
      );

    await tx.delete(stops).where(autoPlannerOptionSql(legId));

    let sortOrder = 1000;
    for (const placed of chosen) {
      const station = byId.get(placed.candidate.id);
      if (!station) continue;
      if (matchesExistingSelected(station.lat, station.lng, existingSelected)) continue;

      const distanceKm = Math.round(placed.candidate.alongKm);
      const name = station.name ?? station.brand ?? 'Fuel station';
      await tx.insert(stops).values({
        legId,
        sortOrder: sortOrder++,
        stopType: 'fuel',
        status: 'option',
        name,
        lat: station.lat,
        lng: station.lng,
        distanceFromStartKm: distanceKm,
        fuelType: null,
        source: 'google',
        sourceUrl: station.googleMapsUri ?? mapsCoordUrl(station.lat, station.lng),
        placeId: station.placeId,
        googleMapsUri: station.googleMapsUri ?? mapsCoordUrl(station.lat, station.lng),
        notes: placed.reason
          ? `Top up here — ${placed.reason}.`
          : `Auto-suggested refuel ≈${distanceKm} km into the leg.`,
        alternatives: null,
      });
    }
  });

  await setFuelStatus(legId, 'ready');
  return { legId, status: 'ready', stopsCreated: chosen.length };
}

/**
 * Lazy, cache-aware entry point for the day-open fuel loader.
 *
 *  - Terminal-success cache (`ready` / `no_stations_found`) inside
 *    `FUEL_CACHE_TTL_MS` → return the cached result, **zero network**.
 *  - Stale, empty (`none`), or `force` → run the full `planFuelStopsForLeg`
 *    search and (re)stamp the cache.
 */
export async function planFuelStopsForLegLazy(
  legId: string,
  userId: string,
  opts: { force?: boolean } = {}
): Promise<FuelPlanResult & { cacheHit: boolean }> {
  if (!opts.force) {
    const rows = await db
      .select({ fuelStatus: legs.fuelStatus, fuelStopsUpdatedAt: legs.fuelStopsUpdatedAt })
      .from(legs)
      .where(eq(legs.id, legId))
      .limit(1);
    const row = rows[0];
    const terminalSuccess =
      row?.fuelStatus === 'ready' || row?.fuelStatus === 'no_stations_found';
    if (
      terminalSuccess &&
      row?.fuelStopsUpdatedAt &&
      Date.now() - row.fuelStopsUpdatedAt.getTime() < FUEL_CACHE_TTL_MS
    ) {
      return {
        legId,
        status: row.fuelStatus as FuelPlanResult['status'],
        cacheHit: true,
      };
    }
  }
  const result = await planFuelStopsForLeg(legId, userId);
  return { ...result, cacheHit: false };
}

/**
 * Invalidate a single leg's lazy fuel cache: drop the planner's auto option
 * stops and reset `fuel_status` to `none`. The next day-open re-sources fuel for
 * THIS leg only — never a trip-wide re-fan-out.
 */
export async function invalidateLegFuelCache(legId: string): Promise<void> {
  await clearAutoPlannerOptionStops(legId);
  await setFuelStatus(legId, 'none');
}

/**
 * Invalidate every leg's lazy fuel cache on a trip. Used when a trip-wide input
 * fuel planning depends on changes (e.g. the assigned vehicle / its range).
 */
export async function invalidateTripFuelCache(tripId: string): Promise<void> {
  const legRows = await db.select({ id: legs.id }).from(legs).where(eq(legs.tripId, tripId));
  for (const row of legRows) {
    await invalidateLegFuelCache(row.id);
  }
}

/**
 * True if a candidate station matches an existing user-promoted ('selected')
 * fuel stop on the same leg by a tight haversine threshold (~80 m). Coordinates
 * are the dedupe key (robust across option/selected rows).
 */
function matchesExistingSelected(
  candidateLat: number,
  candidateLng: number,
  existing: Array<{ lat: number | null; lng: number | null; stopType: string }>
): boolean {
  for (const e of existing) {
    if (e.stopType !== 'fuel') continue;
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

function autoPlannerOptionSql(legId: string) {
  return and(
    eq(stops.legId, legId),
    eq(stops.source, 'google'),
    eq(stops.status, 'option'),
    eq(stops.stopType, 'fuel')
  );
}

async function clearAutoPlannerOptionStops(legId: string): Promise<void> {
  await db.delete(stops).where(autoPlannerOptionSql(legId));
}

// NOTE: the trip-wide fuel fan-out (`replenishFuelStopsForTrip` + its
// POST /api/trips/[id]/fuel-stops/replan endpoint) was REMOVED 2026-07-02.
// Fuel is sourced exclusively lazily, one leg at a time, on day-open
// (planFuelStopsForLegLazy). Do not reintroduce a whole-trip fan-out — the
// eager model was the original API cost sink the lazy design replaced.

async function resolveVehicleForTrip(
  tripId: string | null,
  userId: string
): Promise<{
  range_km: number | null;
  fuel_type: 'diesel' | 'petrol' | null;
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

/** Resolved `trips.declared_range_*` anchor: burned-km baseline at a leg's start. */
type DeclaredTankAnchor = { legId: string; burnedKm: number };

/**
 * Resolve the trip's declared tank state (the `declare_fuel_state` Penny tool)
 * into a burned-km baseline at its anchor leg's start. Returns null when there
 * is no declaration or the anchor leg no longer exists on this trip (the
 * anchor is a plain uuid, no FK — a deleted leg leaves a stale pointer that is
 * deliberately ignored, same contract as `trips.current_leg_id`).
 *
 * burnedKm = fuel range − declared remaining km, clamped ≥ 0 (a driver
 * declaring MORE than the vehicle's range is treated as a full tank).
 */
async function resolveDeclaredTankAnchor(
  tripId: string,
  rangeKm: number
): Promise<DeclaredTankAnchor | null> {
  const rows = await db
    .select({
      declaredRangeKm: trips.declaredRangeKm,
      declaredRangeLegId: trips.declaredRangeLegId,
    })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);
  const t = rows[0];
  if (!t?.declaredRangeKm || !t.declaredRangeLegId) return null;

  const anchorLeg = await db
    .select({ id: legs.id })
    .from(legs)
    .where(and(eq(legs.id, t.declaredRangeLegId), eq(legs.tripId, tripId)))
    .limit(1);
  if (anchorLeg.length === 0) return null;

  return {
    legId: t.declaredRangeLegId,
    burnedKm: Math.max(0, rangeKm - t.declaredRangeKm),
  };
}

/**
 * DB shim around the pure [[kmBurnedSinceLastRefuel]] tank-state math. Walks
 * back through preceding legs (by sort_order) gathering each leg's distance and
 * the position of its last actual fuel stop, then returns how much range is gone
 * when this leg starts.
 *
 * Model: the whole trip is one continuous drive; only an actual fuel stop (or
 * the trip start) refills the tank — rest days/overnights do NOT. Both
 * `selected` and `option` fuel stops count as refuels; `dismissed` does not.
 * Returns 0 for the first leg.
 *
 * `declaredAnchor` (optional): the driver's declared tank state resolved by
 * [[resolveDeclaredTankAnchor]]. When the anchor is one of the preceding legs,
 * its `declaredBurnedKmAtStart` joins the walk — the pure math stops there
 * unless a real fuel stop (a refuel, which supersedes the declaration) is
 * found first. An anchor at the leg being planned is handled by the caller
 * (the declaration IS the burn at that leg's start).
 */
async function computeKmBurnedSinceLastRefuel(
  tripId: string,
  thisLegSortOrder: number,
  declaredAnchor?: DeclaredTankAnchor | null
): Promise<number> {
  const previous = await db
    .select({ id: legs.id, distanceKm: legs.distanceKm })
    .from(legs)
    .where(and(eq(legs.tripId, tripId), lt(legs.sortOrder, thisLegSortOrder)))
    .orderBy(desc(legs.sortOrder));

  if (previous.length === 0) return 0;

  const history: LegFuelHistory[] = [];
  for (const prev of previous) {
    const stopRows = await db
      .select({
        stopType: stops.stopType,
        status: stops.status,
        distanceFromStartKm: stops.distanceFromStartKm,
      })
      .from(stops)
      .where(eq(stops.legId, prev.id));

    const latestFuel = stopRows
      .filter(
        (s) =>
          s.stopType === 'fuel' &&
          s.status !== 'dismissed' &&
          s.distanceFromStartKm != null
      )
      .sort((a, b) => (b.distanceFromStartKm ?? 0) - (a.distanceFromStartKm ?? 0))[0];

    const isDeclaredAnchor = declaredAnchor != null && prev.id === declaredAnchor.legId;

    history.push({
      distanceKm: prev.distanceKm,
      latestFuelDistanceKm: latestFuel?.distanceFromStartKm ?? null,
      declaredBurnedKmAtStart: isDeclaredAnchor ? declaredAnchor.burnedKm : null,
    });

    // Both are terminal for the walk: a fuel stop is a refuel; the declared
    // anchor is the tank baseline (nothing before it matters).
    if (latestFuel?.distanceFromStartKm != null || isDeclaredAnchor) break;
  }

  return kmBurnedSinceLastRefuel(history);
}
