import {
  requireUserId,
  assertTripReadableByUser,
  errorResponse,
} from '@/server/auth/guards';
import { getPoisForTrip } from '@/server/repos/pois';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(request.url);
    const tripIdRaw = url.searchParams.get('tripId');
    if (!tripIdRaw) return Response.json({ error: 'tripId is required' }, { status: 400 });
    const tripId = parseUUID(tripIdRaw);
    if (!tripId) return Response.json({ error: 'tripId must be a valid UUID' }, { status: 400 });
    await assertTripReadableByUser(tripId, userId);
    return Response.json(await getPoisForTrip(tripId));
  } catch (err) {
    return errorResponse(err);
  }
}
