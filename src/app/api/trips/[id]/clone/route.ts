import { requireUserId, assertTripReadableByUser, errorResponse } from '@/server/auth/guards';
import { cloneTrip, getTripFull } from '@/server/repos/trips';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const sourceId = parseUUID(params.id);
    if (!sourceId) return Response.json({ error: 'Invalid trip id' }, { status: 400 });
    await assertTripReadableByUser(sourceId, userId);
    const newTripId = await cloneTrip(sourceId, userId);
    const trip = await getTripFull(newTripId);
    return Response.json({ id: newTripId, trip });
  } catch (err) {
    return errorResponse(err);
  }
}
