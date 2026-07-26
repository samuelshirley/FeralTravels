/**
 * GET /api/debug/fuel — checks every dependency Finn (the fuel planner) needs.
 * Hit this in the browser after logging in to see exactly what's failing.
 *
 * Finn's data sources (all Google Maps Platform): Directions (route geometry) +
 * Places search-along-route (stations). Both use the server Google key.
 */
import { requireUserId } from '@/server/auth/guards';
import { getDefaultVehicleForUser } from '@/server/repos/vehicles';
import { computeEffectiveRangeKm } from '@/lib/penny/context';
import { getDirections } from '@/lib/google/directions';
import { encodePolyline, type LatLng } from '@/lib/polyline';
import { searchFuelAlongRoute } from '@/lib/google/places';
import { filterUsableStations } from '@/lib/finn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const userId = await requireUserId();
    const results: Record<string, unknown> = {};

    // 1. Vehicle / range — Finn uses the stated comfortable + hard-max ranges.
    let range: number | null = null;
    try {
      const v = await getDefaultVehicleForUser(userId);
      if (!v) {
        results['vehicle'] = 'No default vehicle found for this user';
      } else {
        range = computeEffectiveRangeKm(v.comfortable_range_km);
        results['vehicle'] = {
          comfortable_range_km: v.comfortable_range_km,
          hard_max_range_km: v.hard_max_range_km,
          effective_range_km: range,
        };
      }
    } catch (e) {
      results['vehicle'] = `Error: ${e instanceof Error ? e.message : String(e)}`;
    }

    // 2. Google Directions reachability + geometry — Barcelona → Girona (~100 km).
    let polyline: LatLng[] = [];
    try {
      const dir = await getDirections(
        { lat: 41.3851, lng: 2.1734 },
        { lat: 41.9794, lng: 2.8214 }
      );
      if (dir.ok) {
        polyline = dir.polyline_points.map(([lat, lng]) => ({ lat, lng }));
        results['directions'] = {
          ok: true,
          distance_km: dir.distance_km,
          points: polyline.length,
        };
      } else {
        results['directions'] = { ok: false, kind: dir.kind, message: dir.message };
      }
    } catch (e) {
      results['directions'] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    // 3. Google Places — stations along the route + how many survive the filter.
    if (polyline.length < 2) {
      results['places'] = 'Skipped — no route geometry from Directions above';
    } else {
      try {
        const corridor = await searchFuelAlongRoute(encodePolyline(polyline));
        const { kept, rejected } = filterUsableStations(corridor);
        results['places'] = {
          ok: true,
          stations_found: corridor.length,
          usable_after_filter: kept.length,
          rejected: rejected.length,
          rejected_sample: rejected.slice(0, 3).map((r) => ({
            name: r.station.name ?? r.station.placeId,
            reason: r.eligibility.reason,
            detail: r.eligibility.detail,
          })),
        };
      } catch (e) {
        results['places'] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    // Summary
    const directionsOk = (results['directions'] as { ok?: boolean })?.ok === true;
    const placesOk = (results['places'] as { ok?: boolean })?.ok === true;
    results['summary'] = !directionsOk
      ? '❌ Google Directions unreachable — route geometry fetch will fail'
      : !placesOk
        ? '❌ Google Places failing — station lookup will fail (check NEXT_PUBLIC_GOOGLE_MAPS_API_KEY + Places API (New) enabled)'
        : !range
          ? '❌ No vehicle / range — set your range on the default vehicle in Settings'
          : '✅ All checks passed — if stops are still missing, trigger a replan';

    return Response.json(results, { status: 200 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
