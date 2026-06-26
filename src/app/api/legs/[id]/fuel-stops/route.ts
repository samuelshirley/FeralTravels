import {
  requireUserId,
  assertLegOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { planFuelStopsForLegLazy } from '@/server/fuel';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/legs/:id/fuel-stops — lazily source auto fuel stops for a leg.
 *
 * This is the day-open loader: the itinerary calls it when the user expands a
 * day, so fuel is sourced lazily (one leg at a time) instead of eagerly across
 * the whole trip during planning. Cache-aware via `planFuelStopsForLegLazy` —
 * a fresh leg (sourced within FUEL_CACHE_TTL_MS) returns from cache with zero
 * Google Places calls; stale / never-sourced legs run the real search.
 *
 * Pass `?force=1` to bypass the cache (e.g. an explicit "re-check now").
 *
 * Runs synchronously and returns fuel_status + count so the UI can re-render
 * without another round trip. For very long legs the search can take several
 * seconds; the client shows a spinner. 'failed' is returned as 200 with a
 * reason (vs a 500) so the UI can render the actionable cause inline.
 */
export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const legId = parseUUID(ctx.params.id);
    if (!legId)
      return Response.json({ error: 'Invalid leg id' }, { status: 400 });
    await assertLegOwnedByUser(legId, userId);
    const force = new URL(req.url).searchParams.get('force') === '1';
    const result = await planFuelStopsForLegLazy(legId, userId, { force });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
