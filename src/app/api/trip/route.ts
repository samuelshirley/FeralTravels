import {
  requireUserId,
  assertTripReadableByUser,
  errorResponse,
} from '@/server/auth/guards';
import { getTripFull } from '@/server/repos/trips';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);
    const tripIdRaw = url.searchParams.get('tripId');
    if (!tripIdRaw) return Response.json({ error: 'tripId is required' }, { status: 400 });
    const tripId = parseInt(tripIdRaw, 10);
    if (Number.isNaN(tripId)) return Response.json({ error: 'tripId must be a number' }, { status: 400 });
    await assertTripReadableByUser(tripId, userId);
    const trip = await getTripFull(tripId);
    if (!trip) return Response.json({ error: 'Trip not found' }, { status: 404 });
    return Response.json(trip);
  } catch (err) {
    return errorResponse(err);
  }
}
