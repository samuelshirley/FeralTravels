import { z } from 'zod';
import {
  requireUserId,
  assertTripOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { replenishFuelStopsForTrip } from '@/server/fuel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Optional request body. If `start_from_sort_order` is supplied, the planner
 * skips every leg whose `sort_order` is below it — used by the client's
 * forward-only auto-replan when only legs at or after a known edit point
 * need re-computing. Empty/missing body = full replan (back-compat).
 */
const replanBody = z
  .object({
    start_from_sort_order: z.number().int().nonnegative().optional(),
  })
  .optional();

/**
 * POST /api/trips/:id/fuel-stops/replan — recompute auto fuel stops for legs
 * on this trip. May take several seconds; the client should show a spinner.
 */
export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const tripId = parseInt(ctx.params.id, 10);
    if (Number.isNaN(tripId)) {
      return Response.json({ error: 'Invalid trip id' }, { status: 400 });
    }
    await assertTripOwnedByUser(tripId, userId);

    // Body is optional. Tolerate empty body, plain {}, or missing JSON
    // (e.g. when a curl client POSTs with no payload).
    let parsed: z.infer<typeof replanBody> = undefined;
    try {
      const text = await req.text();
      if (text.trim().length > 0) {
        parsed = replanBody.parse(JSON.parse(text));
      }
    } catch {
      /* ignore — fall through to full replan */
    }

    await replenishFuelStopsForTrip(tripId, userId, {
      startFromSortOrder: parsed?.start_from_sort_order,
    });
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
