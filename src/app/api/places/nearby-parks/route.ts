import {
  assertTripReadableByUser,
  errorResponse,
  requireUserId,
} from '@/server/auth/guards';
import { getLegTripId } from '@/server/repos/tasks';
import { nearbyParksAround } from '@/server/places/nearby-parks';

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

    const tripId = tripIdRaw ? parseInt(tripIdRaw, 10) : NaN;
    const legId = legIdRaw ? parseInt(legIdRaw, 10) : NaN;
    if (Number.isNaN(tripId) || tripId <= 0) {
      return Response.json({ error: 'tripId is required and must be a positive integer' }, { status: 400 });
    }
    if (Number.isNaN(legId) || legId <= 0) {
      return Response.json({ error: 'legId is required and must be a positive integer' }, { status: 400 });
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

    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return Response.json(
        {
          error: 'Places search unavailable — NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not set.',
          dogParks: [],
          parks: [],
        },
        { status: 503 }
      );
    }

    const { payload, error } = await nearbyParksAround({ lat, lng }, apiKey);

    return Response.json(
      error ? { ...payload, error } : payload,
      { status: 200 }
    );
  } catch (err) {
    return errorResponse(err);
  }
}
