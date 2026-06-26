/**
 * GET /api/debug/fuel — checks every dependency Finn (the fuel planner) needs.
 * Hit this in the browser after logging in to see exactly what's failing.
 *
 * Finn's data sources: OSRM (route geometry, free) + OSM Overpass (stations,
 * free, ODbL). No Google Places key is involved in fuel planning anymore.
 */
import { requireUserId } from '@/server/auth/guards';
import { getDefaultVehicleForUser } from '@/server/repos/vehicles';
import { computeEffectiveRangeKm } from '@/lib/penny/context';
import { getDirections } from '@/lib/directions';
import { decodePolyline } from '@/lib/polyline';
import { fetchFuelCorridor } from '@/lib/osm/overpass';
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

    // 2. OSRM reachability + geometry — Barcelona → Girona (~100 km).
    let geometry: string | undefined;
    try {
      const dir = await getDirections(41.3851, 2.1734, 41.9794, 2.8214);
      geometry = dir?.geometry;
      results['osrm'] = dir
        ? { ok: true, distance_km: dir.distance_km, has_geometry: !!dir.geometry }
        : { ok: false, reason: 'getDirections returned null' };
    } catch (e) {
      results['osrm'] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    // 3. OSM Overpass — stations in the corridor + how many survive the filter.
    if (!geometry) {
      results['osm_overpass'] = 'Skipped — no route geometry from OSRM above';
    } else {
      try {
        const polyline = decodePolyline(geometry);
        const corridor = await fetchFuelCorridor(polyline, { bufferMeters: 2000 });
        const { kept, rejected } = filterUsableStations(corridor);
        results['osm_overpass'] = {
          ok: true,
          stations_found: corridor.length,
          usable_after_filter: kept.length,
          rejected: rejected.length,
          rejected_sample: rejected.slice(0, 3).map((r) => ({
            name: r.station.name ?? r.station.brand ?? r.station.osmId,
            reason: r.eligibility.reason,
            detail: r.eligibility.detail,
          })),
        };
      } catch (e) {
        results['osm_overpass'] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    // Summary
    const osrmOk = (results['osrm'] as { ok?: boolean })?.ok === true;
    const osmOk = (results['osm_overpass'] as { ok?: boolean })?.ok === true;
    results['summary'] = !osrmOk
      ? '❌ OSRM unreachable — route geometry fetch will fail'
      : !osmOk
        ? '❌ OSM Overpass failing — station lookup will fail (usually transient; retry)'
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
