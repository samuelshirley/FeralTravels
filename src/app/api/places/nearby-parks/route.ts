import {
  assertTripReadableByUser,
  errorResponse,
  requireUserId,
} from '@/server/auth/guards';
import { getLegTripId } from '@/server/repos/tasks';
import { nearbyParksAround } from '@/server/places/nearby-parks';
import { googleMapsApiKeyForServer } from '@/server/google-maps-server-key';
import { logGooglePlacesUsage } from '@/server/repos/usage';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(request.url);
    const tripIdRaw = url.searchParams.get('tripId');
    const legIdRaw = url.searchParams.get('legId');
    const latRaw = url.searchParams.get('lat');
    const lngRaw = url.searchParams.get('lng');

    const tripId = tripIdRaw ? parseUUID(tripIdRaw) : null;
    const legId = legIdRaw ? parseUUID(legIdRaw) : null;
    if (!tripId) {
      return Response.json({ error: 'tripId is required and must be a valid UUID' }, { status: 400 });
    }
    if (!legId) {
      return Response.json({ error: 'legId is required and must be a valid UUID' }, { status: 400 });
    }
    const lat = latRaw ? parseFloat(latRaw) : NaN;
    const lng = lngRaw ? parseFloat(lngRaw) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return Response.json({ error: 'lat and lng must be valid numbers' }, { status: 400 });
    }

    const tripFromLeg = await getLegTripId(legId);
    if (!tripFromLeg || tripFromLeg !== tripId) {
      return Response.json({ error: 'Leg does not belong to this trip' }, { status: 404 });
    }
    await assertTripReadableByUser(tripId, userId);

    const apiKey = googleMapsApiKeyForServer();
    if (!apiKey) {
      return Response.json(
        {
          error:
            'Places search unavailable — set GOOGLE_MAPS_SERVER_API_KEY and/or NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.',
          dogParks: [],
          parks: [],
        },
        { status: 503 }
      );
    }

    const { payload, error } = await nearbyParksAround({ lat, lng }, apiKey);

    // Log Places API usage — parks requests use Pro tier (googleMapsUri field).
    // May fire 1-2 underlying calls (dog parks inner + outer, parks inner + outer).
    logGooglePlacesUsage({
      userId,
      tripId,
      endpoint: 'nearby-search-pro',
      requests: 2, // conservative estimate: dog parks + general parks
      success: !error,
      errorMessage: error ?? null,
    }).catch((e) => console.warn('[usage] logGooglePlacesUsage failed:', e));

    return Response.json(
      error ? { ...payload, error } : payload,
      { status: 200 }
    );
  } catch (err) {
    return errorResponse(err);
  }
}
