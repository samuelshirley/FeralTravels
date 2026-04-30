import {
  requireUserId,
  assertTripOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { replenishFuelStopsForTrip } from '@/server/fuel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/trips/:id/fuel-stops/replan — recompute auto fuel stops for every
 * leg (in order). May take several seconds; the client should show a spinner.
 */
export async function POST(_req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const tripId = parseInt(ctx.params.id, 10);
    if (Number.isNaN(tripId)) {
      return Response.json({ error: 'Invalid trip id' }, { status: 400 });
    }
    await assertTripOwnedByUser(tripId, userId);
    await replenishFuelStopsForTrip(tripId, userId);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
