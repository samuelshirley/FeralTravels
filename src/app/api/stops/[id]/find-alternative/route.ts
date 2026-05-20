import {
  requireUserId,
  assertStopOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { findAlternativeDumpStation } from '@/server/dump-stations';
import { updateStop } from '@/server/repos/stops';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/stops/:id/find-alternative — find the next closest dump station
 * and swap it in. Used by the "Find other station" button on dump station
 * StopCards.
 *
 * Expects optional JSON body: { country_code?: string }
 *
 * Returns the updated stop data or an error reason.
 */
export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const stopId = parseUUID(ctx.params.id);
    if (!stopId)
      return Response.json({ error: 'Invalid stop id' }, { status: 400 });

    await assertStopOwnedByUser(stopId, userId);

    let countryCode: string | null = null;
    try {
      const body = await req.json();
      if (body?.country_code && typeof body.country_code === 'string') {
        countryCode = body.country_code.slice(0, 2).toUpperCase();
      }
    } catch {
      // No body or invalid JSON — that's fine, we'll use default queries
    }

    const result = await findAlternativeDumpStation({
      stopId,
      userId,
      countryCode,
    });

    if (!result.ok) {
      return Response.json(
        { error: result.reason, found: false },
        { status: 200 }
      );
    }

    const c = result.candidate;

    // Update the existing stop in-place with the new candidate
    await updateStop(stopId, {
      name: c.name,
      lat: c.lat,
      lng: c.lng,
      place_id: c.placeId,
      google_maps_uri: c.googleMapsUri,
      notes: `Dump station ${c.distanceKm.toFixed(1)} km away`,
    });

    return Response.json({
      found: true,
      stop: {
        id: stopId,
        name: c.name,
        lat: c.lat,
        lng: c.lng,
        place_id: c.placeId,
        google_maps_uri: c.googleMapsUri,
        distance_km: c.distanceKm,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
