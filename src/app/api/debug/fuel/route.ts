/**
 * GET /api/debug/fuel — checks every dependency the fuel planner needs.
 * Hit this in the browser after logging in to see exactly what's failing.
 */
import { requireUserId } from '@/server/auth/guards';
import { getDefaultVehicleForUser } from '@/server/repos/vehicles';
import { computeEffectiveRangeKm } from '@/lib/penny/context';
import { getDirections } from '@/lib/directions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const userId = await requireUserId();
    const results: Record<string, unknown> = {};

    // 1. Google Maps API key presence
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    results['env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY'] = key
      ? `set (${key.slice(0, 8)}…)`
      : 'MISSING — fuel planning will always fail';

    // 2. Vehicle / effective range — post-0007 the planner uses the user's
    // stated `refill_distance_km` directly. The old fuel_economy × tank × 0.8
    // computation lived here; both the column reads and the multi-arg helper
    // signature were dropped in the same migration.
    let range: number | null = null;
    try {
      const v = await getDefaultVehicleForUser(userId);
      if (!v) {
        results['vehicle'] = 'No default vehicle found for this user';
      } else {
        range = computeEffectiveRangeKm(v.refill_distance_km);
        results['vehicle'] = {
          refill_distance_km: v.refill_distance_km,
          effective_range_km: range,
        };
      }
    } catch (e) {
      results['vehicle'] = `Error: ${e instanceof Error ? e.message : String(e)}`;
    }

    // 3. OSRM reachability — Barcelona → Girona (~100 km)
    try {
      const dir = await getDirections(41.3851, 2.1734, 41.9794, 2.8214);
      results['osrm'] = dir
        ? { ok: true, distance_km: dir.distance_km, has_geometry: !!dir.geometry }
        : { ok: false, reason: 'getDirections returned null' };
    } catch (e) {
      results['osrm'] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    // 4. Google Places API (New) — gas stations near Barcelona
    if (!key) {
      results['places_api'] = 'Skipped — no API key';
    } else {
      try {
        const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': key,
            'X-Goog-FieldMask': 'places.displayName,places.location,places.id',
          },
          body: JSON.stringify({
            includedTypes: ['gas_station'],
            maxResultCount: 2,
            locationRestriction: {
              circle: {
                center: { latitude: 41.3851, longitude: 2.1734 },
                radius: 5000,
              },
            },
          }),
        });

        const body = await res.text();
        if (!res.ok) {
          results['places_api'] = {
            ok: false,
            http_status: res.status,
            body: body.slice(0, 400),
            hint:
              res.status === 403
                ? 'KEY HAS HTTP REFERRER RESTRICTIONS — server-side calls are blocked. In Google Cloud Console, remove referrer restrictions from this key or create a separate unrestricted server key.'
                : res.status === 400
                  ? 'BAD REQUEST — "Places API (New)" is probably not enabled. In Google Cloud Console → APIs & Services → Enable APIs, search for "Places API (New)" and enable it.'
                  : 'Check Google Cloud Console for key/quota issues.',
          };
        } else {
          const data = JSON.parse(body);
          results['places_api'] = {
            ok: true,
            stations_found: data.places?.length ?? 0,
            sample: data.places?.[0]?.displayName?.text ?? null,
          };
        }
      } catch (e) {
        results['places_api'] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    // Summary
    const placesOk = (results['places_api'] as any)?.ok === true;
    const osrmOk = (results['osrm'] as any)?.ok === true;
    results['summary'] = !key
      ? '❌ Missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY'
      : !osrmOk
        ? '❌ OSRM unreachable — route geometry fetch will fail'
        : !placesOk
          ? `❌ Places API failing — ${(results['places_api'] as any)?.hint ?? 'see places_api above'}`
          : !range
            ? '❌ No vehicle / effective range — set "Refill every X km" on your default vehicle in Settings'
            : '✅ All checks passed — if stops are still missing, trigger a replan';

    return Response.json(results, { status: 200 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
