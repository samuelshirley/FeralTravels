import 'server-only';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { legs, stops } from '@/server/db/schema';
import { getDirections } from '@/lib/directions';
import {
  decodePolyline,
  haversineKm,
  polylineLengthKm,
  type LatLng,
} from '@/lib/polyline';
import { computeEffectiveRangeKm } from '@/lib/penny/context';
import { FUEL_CACHE_TTL_MS } from '@/lib/fuelCache';
import {
  kmBurnedSinceLastRefuel,
  type LegFuelHistory,
} from '@/lib/penny/fuelTankState';
import { getVehicleForUser, getDefaultVehicleForUser } from '@/server/repos/vehicles';
import {
  fetchFuelCorridor,
  type OsmFuelStation,
} from '@/lib/osm/overpass';
import {
  filterUsableStations,
  planLegFuelStops,
  projectPointOntoRoute,
  cumulativeDistancesKm,
  type PlacementCandidate,
} from '@/lib/finn';
import {
  resolveStationPrices,
  NO_PRICE_COUNTRIES,
  type FuelType,
  type PriceResult,
  type PriceableStation,
} from '@/lib/fuelPricing';
import { buildBulkPriceProviders, buildPriceProviders } from '@/server/fuelPricingProviders';

/**
 * Auto fuel-stop planner — **Finn** (OSM + deterministic placement).
 *
 * Flow for a leg with start + end coords and a vehicle on file:
 *   1. Fetch the OSRM polyline for start→end (route geometry, never stored).
 *   2. Query OSM Overpass for fuel stations in a tight corridor around it.
 *   3. Drop truck-only / private stations (`stationFilter.ts`).
 *   4. Project each remaining station onto the route (along-km + detour proxy).
 *   5. Run the greedy multi-stop placer (`finn/plan.ts`): never route past the
 *      hard-max ceiling, prefer comfortable range, prefer priced+cheapest
 *      stations (pricing layer lands later — candidates are price-unknown today).
 *   6. Replace previous auto fuel stops (source='osm', status='option').
 *      User-picked / user-authored stops are never touched.
 *
 * Data-source split (legal backbone): OSM station data is ODbL — storable in the
 * `stops` cache with attribution. Google place data is NOT persisted anywhere in
 * this path anymore. Routing geometry comes from OSRM (free, no key).
 *
 * Fails loudly (`fuel_status='failed'` + `fuel_plan_error`) when the vehicle has
 * no range data, the route can't be decoded, or Overpass errors. A genuinely
 * remote leg with no reachable station is `no_stations_found` (not a failure).
 */

// Hard cap on how many fuel stops we'll propose per leg — keeps a very long leg
// from spawning a cluttered list of option rows.
const MAX_STOPS_PER_LEG = 8;
// Minimum leg length to bother planning at all. Under this, the tank almost
// certainly covers the drive.
const MIN_LEG_KM_FOR_PLANNING = 100;
// Carry-over allowance: if cumulative km since the last refuel + this leg's
// distance is under range × this, skip planning (and the Overpass call) entirely.
const SKIP_PLANNING_THRESHOLD = 0.7;
// Max straight-line distance a station may sit off the route to still count as
// "on the way." The Overpass corridor buffer is ~2 km, but it widens on long
// legs; this caps the detour we'll ever propose.
const MAX_DETOUR_KM = 15;
// Overpass corridor half-width around the route polyline.
const CORRIDOR_BUFFER_METERS = 2000;

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

/** Single-destination Google Maps link built from coords (no Google place data). */
function mapsCoordUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/** Map a tri-state PriceResult to the stop row's price columns. */
function priceColumns(pr: PriceResult | undefined) {
  if (pr?.state === 'priced') {
    return {
      priceState: 'priced',
      pricePerLitre: pr.price.amount,
      priceCurrency: pr.price.currency,
      priceFuelType: pr.price.fuelType,
      priceCountry: null,
      priceSource: pr.price.source,
      priceAsOf: new Date(pr.price.asOf),
    };
  }
  if (pr?.state === 'unavailable_in_country') {
    return {
      priceState: 'unavailable_in_country',
      pricePerLitre: null,
      priceCurrency: null,
      priceFuelType: null,
      priceCountry: pr.country,
      priceSource: null,
      priceAsOf: null,
    };
  }
  return {
    priceState: pr?.state === 'unknown' ? 'unknown' : null,
    pricePerLitre: null,
    priceCurrency: null,
    priceFuelType: null,
    priceCountry: null,
    priceSource: null,
    priceAsOf: null,
  };
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

  await setFuelStatus(legId, 'computing');

  // 2. Resolve the vehicle for this trip (falls back to the user's default).
  const vehicle = await resolveVehicleForTrip(leg.tripId, userId);
  if (!vehicle) {
    const reason = 'No vehicle on file for user';
    await setFuelStatus(legId, 'failed', reason);
    return { legId, status: 'failed', reason };
  }
  const range = computeEffectiveRangeKm(vehicle.comfortable_range_km);
  if (!range) {
    const reason =
      'Vehicle is missing a refill distance. Open Settings → Vehicle profile and tell Penny how far you want to drive between fuel stops.';
    await setFuelStatus(legId, 'failed', reason);
    return { legId, status: 'failed', reason };
  }
  // Hard ceiling — never route a dry stretch past this. Defaults to the
  // comfortable range when the user gave no separate ceiling (the invariant
  // hard_max ≥ comfortable is enforced at every write path).
  const hardMax = Math.max(range, vehicle.hard_max_range_km ?? range);
  // Fuel type drives which per-fuel price we fetch. Defaults to diesel (the
  // overlander norm) until the driver sets it; see vehicles.fuel_type.
  const fuelType: FuelType = vehicle.fuel_type === 'petrol' ? 'petrol' : 'diesel';

  // 3. OSRM route geometry (free, no key). We need the full polyline to project
  //    stations onto it.
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

  // Cross-leg fuel state: how much range is already gone when this leg starts.
  // Without this, three sequential 500 km legs each pass the "fits within range"
  // check individually and zero stops get proposed even though the tank empties.
  const kmAlreadyBurned = await computeKmBurnedSinceLastRefuel(leg.tripId, leg.sortOrder);

  const belowMinLeg = totalKm < MIN_LEG_KM_FOR_PLANNING;
  const cumulativeFitsComfortably =
    kmAlreadyBurned + totalKm < range * SKIP_PLANNING_THRESHOLD;

  // Early exit (and skip the Overpass call) when no stop can be needed.
  if (belowMinLeg || cumulativeFitsComfortably) {
    await clearAutoPlannerOptionStops(legId);
    await setFuelStatus(legId, 'ready');
    return { legId, status: 'ready', stopsCreated: 0 };
  }

  // 4. OSM corridor → eligibility filter → route projection → candidates.
  let corridor: OsmFuelStation[];
  try {
    corridor = await fetchFuelCorridor(
      polyline,
      { bufferMeters: CORRIDOR_BUFFER_METERS },
      // Point at a self-hosted / paid Overpass before scale; falls back to the
      // public instance when unset (fair-use only — see finn-fuel-agent.md).
      { endpoint: process.env.OVERPASS_ENDPOINT?.trim() || undefined }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = `Couldn't reach the OSM station service (${msg}). This is usually transient — try again shortly.`;
    await setFuelStatus(legId, 'failed', reason);
    console.error(`[finn] userId=${userId} tripId=${leg.tripId} legId=${legId}: ${msg}`);
    return { legId, status: 'failed', reason };
  }

  const { kept } = filterUsableStations(corridor);
  const cumulative = cumulativeDistancesKm(polyline);
  const byId = new Map<string, OsmFuelStation>();
  const candidates: PlacementCandidate[] = [];
  for (const st of kept) {
    const proj = projectPointOntoRoute({ lat: st.lat, lng: st.lng }, polyline, cumulative);
    if (proj.perpKm > MAX_DETOUR_KM) continue;
    byId.set(st.osmId, st);
    candidates.push({
      id: st.osmId,
      alongKm: proj.alongKm,
      detourKm: proj.perpKm,
      pricePerLitre: null, // filled below by the bulk pricing pass when available
    });
  }

  // 4b. Price candidates for selection — BULK providers only (feeds are cheap
  //     enough to price every candidate; per-station Google is reserved for
  //     finalist display). Feeds `pricePerLitre` into the planner so it can
  //     prefer the cheapest in-range station. No providers configured / no key
  //     → no prices → selection falls back to distance (graceful).
  const bulkProviders = buildBulkPriceProviders();
  if (bulkProviders.length > 0 && candidates.length > 0) {
    const priceable: PriceableStation[] = candidates.map((c) => {
      const st = byId.get(c.id)!;
      return {
        id: c.id,
        lat: st.lat,
        lng: st.lng,
        name: st.name,
        brand: st.brand,
        country: st.tags['addr:country'] ?? null,
      };
    });
    const selectionPrices = await resolveStationPrices(priceable, fuelType, bulkProviders);
    for (const c of candidates) {
      const pr = selectionPrices.get(c.id);
      if (pr?.state === 'priced') c.pricePerLitre = pr.price.amount;
    }
  }

  // 5. Deterministic greedy placement.
  const plan = planLegFuelStops({
    legLengthKm: totalKm,
    comfortableRangeKm: range,
    hardMaxRangeKm: hardMax,
    kmBurnedAtStart: kmAlreadyBurned,
    candidates,
  });

  if (plan.gap) {
    // A stop is needed but nothing reachable sits before the ceiling — honest
    // warning, not an empty "ready" plan that looks safe. [[feedback_fuel_safety_bias]]
    const reason =
      plan.gapDetail ??
      'This leg is too remote for an auto-planned stop — carry extra fuel or plan a stop manually.';
    await clearAutoPlannerOptionStops(legId);
    await setFuelStatus(legId, 'no_stations_found', reason);
    return { legId, status: 'no_stations_found', reason, stopsCreated: 0 };
  }

  const chosen = plan.stops.slice(0, MAX_STOPS_PER_LEG);

  // 5b. Authoritative tri-state price for each chosen finalist (display +
  //     persistence). Runs ALL providers — bulk re-checks the few finalists,
  //     per-station Google fills gaps — EXCEPT a known no-price country (the
  //     Nordics) resolves to `unavailable_in_country` upfront, never burning a
  //     Google call there. No providers configured → empty map → price columns
  //     stay null (no price UI).
  const allProviders = buildPriceProviders();
  const finalPrices = new Map<string, PriceResult>();
  if (allProviders.length > 0 && chosen.length > 0) {
    const finalists: PriceableStation[] = [];
    for (const placed of chosen) {
      const st = byId.get(placed.candidate.id);
      if (!st) continue;
      const country = st.tags['addr:country'] ?? null;
      if (country && NO_PRICE_COUNTRIES.has(country)) {
        finalPrices.set(placed.candidate.id, { state: 'unavailable_in_country', country });
        continue;
      }
      finalists.push({
        id: placed.candidate.id,
        lat: st.lat,
        lng: st.lng,
        name: st.name,
        brand: st.brand,
        country,
      });
    }
    if (finalists.length > 0) {
      const resolved = await resolveStationPrices(finalists, fuelType, allProviders);
      for (const [id, pr] of resolved) finalPrices.set(id, pr);
    }
  }

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
          eq(stops.source, 'osm'),
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
        source: 'osm',
        sourceUrl: mapsCoordUrl(station.lat, station.lng),
        placeId: null,
        googleMapsUri: mapsCoordUrl(station.lat, station.lng),
        notes: placed.reason
          ? `Top up here — ${placed.reason}.`
          : `Auto-suggested refuel ≈${distanceKm} km into the leg.`,
        alternatives: null,
        ...priceColumns(finalPrices.get(placed.candidate.id)),
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
 * fuel stop on the same leg by a tight haversine threshold (~80 m). OSM stations
 * carry no Google place_id, so coordinates are the dedupe key.
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
    eq(stops.source, 'osm'),
    eq(stops.status, 'option'),
    eq(stops.stopType, 'fuel')
  );
}

async function clearAutoPlannerOptionStops(legId: string): Promise<void> {
  await db.delete(stops).where(autoPlannerOptionSql(legId));
}

export interface ReplenishFuelStopsOptions {
  /**
   * Skip every leg whose `sort_order` is strictly less than this value
   * (forward-only replan; cumulative tank math flows forward). Omit to replan
   * every leg.
   */
  startFromSortOrder?: number;
}

/**
 * Re-run auto fuel planning for legs on a trip in sort order (needed for
 * cumulative tank state across legs). Failures on one leg are logged; the rest
 * still run. Manual/admin re-plan only — not auto-triggered.
 */
export async function replenishFuelStopsForTrip(
  tripId: string,
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
  tripId: string | null,
  userId: string
): Promise<{
  comfortable_range_km: number | null;
  hard_max_range_km: number | null;
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
 */
async function computeKmBurnedSinceLastRefuel(
  tripId: string,
  thisLegSortOrder: number
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

    history.push({
      distanceKm: prev.distanceKm,
      latestFuelDistanceKm: latestFuel?.distanceFromStartKm ?? null,
    });

    if (latestFuel?.distanceFromStartKm != null) break;
  }

  return kmBurnedSinceLastRefuel(history);
}
