import 'server-only';
import { and, eq } from 'drizzle-orm';
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
import { computeEffectiveRangeKm } from '@/lib/penny/context';
import { getVehicleForUser, getDefaultVehicleForUser } from '@/server/repos/vehicles';
import type { FuelType } from '@/types/trip';

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
 *      = 'google_places', status='option'). User-picked / user-authored
 *      stops are never touched.
 *
 * Fails loudly (sets fuel_status='failed' and returns details) when the
 * Places key is missing, the vehicle has no fuel data, or the route
 * couldn't be decoded. The UI reads fuel_status to decide whether to
 * show a retry affordance.
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

export interface FuelPlanResult {
  legId: number;
  status: 'ready' | 'failed' | 'skipped';
  reason?: string;
  stopsCreated?: number;
}

/** Quick status-only mutation; reused from both the worker and the API. */
async function setFuelStatus(
  legId: number,
  status: 'none' | 'pending' | 'computing' | 'ready' | 'failed'
) {
  await db
    .update(legs)
    .set({ fuelStatus: status, updatedAt: new Date() })
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
    await setFuelStatus(legId, 'failed');
    return { legId, status: 'failed', reason: 'No vehicle on file for user' };
  }
  const range = computeEffectiveRangeKm(
    vehicle.fuel_economy_kmpl,
    vehicle.fuel_tank_l
  );
  if (!range) {
    await setFuelStatus(legId, 'failed');
    return {
      legId,
      status: 'failed',
      reason: 'Vehicle is missing fuel economy or tank size',
    };
  }

  const placesKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!placesKey) {
    await setFuelStatus(legId, 'failed');
    return {
      legId,
      status: 'failed',
      reason:
        'Server is missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY. Add it to .env to enable auto fuel stops.',
    };
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
    await setFuelStatus(legId, 'failed');
    return { legId, status: 'failed', reason: 'Could not fetch route geometry' };
  }

  const polyline = decodePolyline(directions.geometry);
  const totalKm = polylineLengthKm(polyline);
  if (polyline.length < 2 || totalKm <= 0) {
    await setFuelStatus(legId, 'failed');
    return { legId, status: 'failed', reason: 'Route geometry was unusable' };
  }

  // Early exit for short legs — nothing useful to plan, and we avoid
  // spending a Places call. We still mark `ready` + return 0 stops so
  // the UI doesn't keep spinning.
  if (totalKm < MIN_LEG_KM_FOR_PLANNING || totalKm < range * 0.7) {
    await clearAutoFuelStops(legId);
    await setFuelStatus(legId, 'ready');
    return { legId, status: 'ready', stopsCreated: 0 };
  }

  const stepKm = range * SAMPLE_FRACTION;
  const samples = samplePolylineEveryKm(polyline, stepKm).slice(
    0,
    MAX_STOPS_PER_LEG
  );

  // 4. Places lookups. Issue them concurrently but bounded — a 10-stop
  //    leg with serial 1-second calls adds 10s to the spinner time.
  const fuel = (vehicle.fuel_type ?? null) as FuelType | null;
  const candidates = await Promise.all(
    samples.map((s) => findBestGasStation(s.point, fuel, placesKey))
  );

  const toInsert = samples
    .map((s, i) => ({ sample: s, station: candidates[i] }))
    .filter((x): x is { sample: (typeof samples)[number]; station: GasStation } => !!x.station);

  // 5. Replace previous auto stops. We use a transactional delete+insert
  //    so the UI never sees a half-applied plan.
  await db.transaction(async (tx) => {
    await tx
      .delete(stops)
      .where(
        and(
          eq(stops.legId, legId),
          eq(stops.source, 'google_places'),
          eq(stops.status, 'option')
        )
      );

    for (let i = 0; i < toInsert.length; i++) {
      const { sample, station } = toInsert[i];
      await tx.insert(stops).values({
        legId,
        sortOrder: 1000 + i, // keep well above user stops
        stopType: 'fuel',
        status: 'option',
        name: station.name,
        lat: station.lat,
        lng: station.lng,
        distanceFromStartKm: Math.round(sample.distance_km),
        fuelType: fuel ?? null,
        source: 'google_places',
        sourceUrl: station.place_id
          ? `https://www.google.com/maps/place/?q=place_id:${station.place_id}`
          : null,
        notes: `Auto-suggested refuel ≈${Math.round(sample.distance_km)} km into the leg.`,
      });
    }
  });

  await setFuelStatus(legId, 'ready');
  return { legId, status: 'ready', stopsCreated: toInsert.length };
}

async function resolveVehicleForTrip(
  tripId: number | null,
  userId: string
): Promise<{
  fuel_economy_kmpl: number | null;
  fuel_tank_l: number | null;
  fuel_type: string | null;
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

async function clearAutoFuelStops(legId: number): Promise<void> {
  await db
    .delete(stops)
    .where(
      and(
        eq(stops.legId, legId),
        eq(stops.source, 'google_places'),
        eq(stops.status, 'option')
      )
    );
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

async function findBestGasStation(
  center: LatLng,
  fuelType: FuelType | null,
  apiKey: string
): Promise<GasStation | null> {
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        // Only request the fields we actually use — keeps the bill small.
        'X-Goog-FieldMask':
          'places.displayName,places.location,places.id,places.primaryType',
      },
      body: JSON.stringify({
        includedTypes: ['gas_station'],
        maxResultCount: 5,
        locationRestriction: {
          circle: {
            center: { latitude: center.lat, longitude: center.lng },
            radius: SEARCH_RADIUS_KM * 1000,
          },
        },
      }),
    });

    if (!res.ok) {
      // Log the body to the server console for debugging but don't throw —
      // one leg's failed Places call shouldn't nuke the whole plan. The
      // caller will skip this sample's stop and carry on.
      const body = await res.text().catch(() => '');
      console.warn(
        `Places nearby search failed: HTTP ${res.status} ${body.slice(0, 200)}`
      );
      return null;
    }

    const data = (await res.json()) as {
      places?: Array<{
        id?: string;
        displayName?: { text?: string };
        location?: { latitude: number; longitude: number };
        primaryType?: string;
      }>;
    };
    const places = data.places ?? [];
    if (places.length === 0) return null;

    // Rank by proximity to `center`. Fuel-type matching via name keyword is
    // weak — most stations carry diesel + petrol — so we skip it for now.
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
          distance: haversineKm(center, { lat: loc.latitude, lng: loc.longitude }),
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => a.distance - b.distance);

    const best = ranked[0];
    if (!best) return null;
    return { name: best.name, lat: best.lat, lng: best.lng, place_id: best.place_id };
  } catch (err) {
    console.warn('Places nearby search threw:', err);
    return null;
  }
}
