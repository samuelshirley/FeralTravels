import {
  requireUserId,
  assertLegOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { planFuelStopsForLeg } from '@/server/fuel';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/legs/:id/fuel-stops — compute (or recompute) auto fuel stops
 * for a leg. Used by the LegCard's "Plan fuel" button and can be kicked
 * off automatically whenever start/end coords change.
 *
 * Runs synchronously and returns the new fuel_status + count so the UI
 * can re-render without another round trip. For very long legs the call
 * can take several seconds; the client should show a spinner.
 */
export async function POST(_req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const legId = parseUUID(ctx.params.id);
    if (!legId)
      return Response.json({ error: 'Invalid leg id' }, { status: 400 });
    await assertLegOwnedByUser(legId, userId);
    const result = await planFuelStopsForLeg(legId, userId);
    // Surface 'failed' as 200 with a reason (vs a 500) so the UI can render
    // the reason inline — it's almost always actionable ("add fuel economy
    // to your vehicle", "set start and end coordinates first").
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
