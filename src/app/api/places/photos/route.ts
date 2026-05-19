import {
  assertTripReadableByUser,
  errorResponse,
  requireUserId,
} from '@/server/auth/guards';
import { getLegTripId } from '@/server/repos/tasks';
import { placePhotos, coordPhotos } from '@/server/places/photos';
import { googleMapsApiKeyForServer } from '@/server/google-maps-server-key';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/places/photos?tripId=X&legId=Y&placeId=Z
 * OR
 * GET /api/places/photos?tripId=X&legId=Y&lat=A&lng=B
 *
 * Returns up to 3 photos for the given place (Place Photos + Street View fallback).
 */
export async function GET(request: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(request.url);
    const tripIdRaw = url.searchParams.get('tripId');
    const legIdRaw = url.searchParams.get('legId');
    const placeId = url.searchParams.get('placeId');
    const latRaw = url.searchParams.get('lat');
    const lngRaw = url.searchParams.get('lng');

    const tripId = tripIdRaw ? parseInt(tripIdRaw, 10) : NaN;
    const legId = legIdRaw ? parseInt(legIdRaw, 10) : NaN;

    if (Number.isNaN(tripId) || tripId <= 0) {
      return Response.json({ error: 'tripId is required' }, { status: 400 });
    }
    if (Number.isNaN(legId) || legId <= 0) {
      return Response.json({ error: 'legId is required' }, { status: 400 });
    }

    if (!placeId && (!latRaw || !lngRaw)) {
      return Response.json(
        { error: 'placeId or lat+lng is required' },
        { status: 400 }
      );
    }

    // Auth check
    const tripFromLeg = await getLegTripId(legId);
    if (!tripFromLeg || tripFromLeg !== tripId) {
      return Response.json({ error: 'Leg does not belong to this trip' }, { status: 404 });
    }
    await assertTripReadableByUser(tripId, userId);

    const apiKey = googleMapsApiKeyForServer();
    if (!apiKey) {
      return Response.json({ photos: [] }, { status: 200 });
    }

    let photos;
    if (placeId) {
      photos = await placePhotos(placeId, apiKey);
    } else {
      const lat = parseFloat(latRaw!);
      const lng = parseFloat(lngRaw!);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return Response.json({ error: 'Invalid lat/lng' }, { status: 400 });
      }
      photos = await coordPhotos(lat, lng, apiKey);
    }

    return Response.json({ photos }, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
