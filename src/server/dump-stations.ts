import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { legs, stops } from '@/server/db/schema';
import { searchDumpStations, type DumpStationCandidate } from '@/server/places/nearby-dump-stations';
import { googleMapsApiKeyForServer } from '@/server/google-maps-server-key';
import { logGooglePlacesUsage } from '@/server/repos/usage';

// ---------------------------------------------------------------------------
// Dump station planner — finds and inserts dump station stops on legs.
//
// Unlike fuel stops (which sample the polyline at range intervals), dump
// stations are placed near the leg's END point. The rationale: the user
// wants to dump + refill before or after arriving at their next campsite,
// not in the middle of a drive.
// ---------------------------------------------------------------------------

export type DumpStationPlanResult =
  | { legId: string; status: 'ok'; stopId: string; candidate: DumpStationCandidate }
  | { legId: string; status: 'no_results'; reason: string }
  | { legId: string; status: 'failed'; reason: string }
  | { legId: string; status: 'skipped'; reason: string };

/**
 * Find and insert a dump station stop on a leg. Searches near the leg's
 * end point, inserts the best candidate as an optional stop, and returns
 * the result.
 *
 * Idempotent-ish: clears any existing auto-generated dump station stops
 * (source='google_places', stop_type='dump_station') on the leg before
 * inserting, so re-calling doesn't accumulate duplicates.
 */
export async function planDumpStationStopForLeg(
  legId: string,
  userId: string,
  countryCode: string | null = null,
): Promise<DumpStationPlanResult> {
  // 1. Load the leg
  const [row] = await db
    .select()
    .from(legs)
    .where(eq(legs.id, legId))
    .limit(1);

  if (!row) {
    return { legId, status: 'failed', reason: 'Leg not found' };
  }

  if (row.endLat == null || row.endLng == null) {
    return { legId, status: 'skipped', reason: 'Leg has no end coordinates yet' };
  }

  // 2. Check for API key
  const apiKey = googleMapsApiKeyForServer();
  if (!apiKey) {
    return {
      legId,
      status: 'failed',
      reason: 'Missing Google Maps API key for server Places calls.',
    };
  }

  // 3. Remove previous auto-generated dump station stops on this leg
  const existingAutoStops = await db
    .select({ id: stops.id })
    .from(stops)
    .where(eq(stops.legId, legId));

  for (const s of existingAutoStops) {
    // Check individual stop properties (stop_type + source) in a separate query
    // since we need to filter by multiple columns
    const [detail] = await db
      .select({ stopType: stops.stopType, source: stops.source })
      .from(stops)
      .where(eq(stops.id, s.id))
      .limit(1);
    if (detail?.stopType === 'dump_station' && detail?.source === 'google_places') {
      await db.delete(stops).where(eq(stops.id, s.id));
    }
  }

  // 4. Search for dump stations
  const searchCenter = { lat: row.endLat, lng: row.endLng };

  const result = await searchDumpStations({
    center: searchCenter,
    apiKey,
    countryCode,
  });

  // Log usage
  logGooglePlacesUsage({
    userId,
    tripId: row.tripId,
    endpoint: 'text-search',
    requests: result.apiCallsMade,
    success: !result.error,
    errorMessage: result.error ?? null,
  }).catch((e) => console.warn('[usage] logGooglePlacesUsage failed:', e));

  if (result.error || result.candidates.length === 0) {
    return {
      legId,
      status: 'no_results',
      reason: result.error ?? 'No dump stations found near this leg.',
    };
  }

  const best = result.candidates[0];

  // 5. Insert the stop
  const [inserted] = await db
    .insert(stops)
    .values({
      legId,
      stopType: 'dump_station',
      name: best.name,
      lat: best.lat,
      lng: best.lng,
      source: 'google_places',
      status: 'option',
      placeId: best.placeId,
      googleMapsUri: best.googleMapsUri,
      notes: `Dump station ${best.distanceKm.toFixed(1)} km from leg end`,
    })
    .returning({ id: stops.id });

  return {
    legId,
    status: 'ok',
    stopId: inserted.id,
    candidate: best,
  };
}

/**
 * Find an alternative dump station for an existing stop. Searches near the
 * current stop's location, excluding the current placeId.
 *
 * Returns the next closest candidate, or null if none found.
 */
export async function findAlternativeDumpStation(opts: {
  stopId: string;
  userId: string;
  countryCode?: string | null;
}): Promise<
  | { ok: true; candidate: DumpStationCandidate }
  | { ok: false; reason: string }
> {
  const [stop] = await db
    .select()
    .from(stops)
    .where(eq(stops.id, opts.stopId))
    .limit(1);

  if (!stop) return { ok: false, reason: 'Stop not found' };
  if (stop.lat == null || stop.lng == null) {
    return { ok: false, reason: 'Stop has no coordinates' };
  }

  const apiKey = googleMapsApiKeyForServer();
  if (!apiKey) return { ok: false, reason: 'Missing Google Maps API key' };

  // Get the leg's trip ID for usage logging
  const [leg] = await db
    .select({ tripId: legs.tripId })
    .from(legs)
    .where(eq(legs.id, stop.legId))
    .limit(1);

  const excludePlaceIds = stop.placeId ? [stop.placeId] : [];

  const result = await searchDumpStations({
    center: { lat: stop.lat, lng: stop.lng },
    apiKey,
    countryCode: opts.countryCode ?? null,
    excludePlaceIds,
  });

  // Log usage
  if (leg) {
    logGooglePlacesUsage({
      userId: opts.userId,
      tripId: leg.tripId,
      endpoint: 'text-search',
      requests: result.apiCallsMade,
      success: !result.error,
      errorMessage: result.error ?? null,
    }).catch((e) => console.warn('[usage] logGooglePlacesUsage failed:', e));
  }

  if (result.error || result.candidates.length === 0) {
    return { ok: false, reason: result.error ?? 'No other dump stations found nearby.' };
  }

  return { ok: true, candidate: result.candidates[0] };
}
