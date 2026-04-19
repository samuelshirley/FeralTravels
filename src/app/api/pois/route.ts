import {
  requireUserId,
  assertTripReadableByUser,
  errorResponse,
} from '@/server/auth/guards';
import { getPoisForTrip } from '@/server/repos/pois';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(request.url);
    const tripIdRaw = url.searchParams.get('tripId');
    if (!tripIdRaw) return Response.json({ error: 'tripId is required' }, { status: 400 });
    const tripId = parseInt(tripIdRaw, 10);
    if (Number.isNaN(tripId)) return Response.json({ error: 'tripId must be a number' }, { status: 400 });
    await assertTripReadableByUser(tripId, userId);
    return Response.json(await getPoisForTrip(tripId));
  } catch (err) {
    return errorResponse(err);
  }
}
