import {
  requireUserId,
  assertTripOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { deleteTrip } from '@/server/repos/trips';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const tripId = parseInt(ctx.params.id, 10);
    if (Number.isNaN(tripId)) {
      return Response.json({ error: 'Invalid trip id' }, { status: 400 });
    }
    // Templates are owned by the demo user, so deletion is blocked here by
    // assertTripOwnedByUser — users can only delete trips they themselves own.
    await assertTripOwnedByUser(tripId, userId);
    await deleteTrip(tripId);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
