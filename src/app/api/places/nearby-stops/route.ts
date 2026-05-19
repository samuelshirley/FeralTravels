import {
  assertTripReadableByUser,
  errorResponse,
  requireUserId,
} from '@/server/auth/guards';
import { getLegTripId } from '@/server/repos/tasks';
import {
  nearbyStopsByCategory,
  type StopCategory,
} from '@/server/places/nearby-stops';
import { googleMapsApiKeyForServer } from '@/server/google-maps-server-key';
import { logGooglePlacesUsage } from '@/server/repos/usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_CATEGORIES: StopCategory[] = ['fuel', 'groceries', 'water', 'parks'];

/**
 * GET /api/places/nearby-stops?tripId=X&legId=Y&lat=A&lng=B&category=fuel
 *
 * Search for nearby places of a specific stop category.
 * Used by the "More Stops" modal to populate category tabs.
 */
export async function GET(request: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(request.url);
    const tripIdRaw = url.searchParams.get('tripId');
    const legIdRaw = url.searchParams.get('legId');
    const latRaw = url.searchParams.get('lat');
    const lngRaw = url.searchParams.get('lng');
    const category = url.searchParams.get('category') as StopCategory | null;

    const tripId = tripIdRaw ? parseInt(tripIdRaw, 10) : NaN;
    const legId = legIdRaw ? parseInt(legIdRaw, 10) : NaN;
    const lat = latRaw ? parseFloat(latRaw) : NaN;
    const lng = lngRaw ? parseFloat(lngRaw) : NaN;

    if (Number.isNaN(tripId) || tripId <= 0) {
      return Response.json({ error: 'tripId is required' }, { status: 400 });
    }
    if (Number.isNaN(legId) || legId <= 0) {
      return Response.json({ error: 'legId is required' }, { status: 400 });
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return Response.json({ error: 'lat and lng must be valid numbers' }, { status: 400 });
    }
    if (!category || !VALID_CATEGORIES.includes(category)) {
      return Response.json(
        { error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` },
        { status: 400 }
      );
    }

    const tripFromLeg = await getLegTripId(legId);
    if (!tripFromLeg || tripFromLeg !== tripId) {
      return Response.json({ error: 'Leg does not belong to this trip' }, { status: 404 });
    }
    await assertTripReadableByUser(tripId, userId);

    const apiKey = googleMapsApiKeyForServer();
    if (!apiKey) {
      return Response.json({ results: [], error: 'Places API unavailable' }, { status: 503 });
    }

    const { results, error } = await nearbyStopsByCategory(
      { lat, lng },
      category,
      apiKey,
      { radiusM: 10000, maxResults: 10 }
    );

    // Log Places API usage — this endpoint requests googleMapsUri (Pro tier).
    logGooglePlacesUsage({
      userId,
      tripId,
      endpoint: 'nearby-search-pro',
      requests: 1,
      success: !error,
      errorMessage: error ?? null,
    }).catch((e) => console.warn('[usage] logGooglePlacesUsage failed:', e));

    return Response.json(
      error ? { results, error } : { results },
      { status: 200 }
    );
  } catch (err) {
    return errorResponse(err);
  }
}
