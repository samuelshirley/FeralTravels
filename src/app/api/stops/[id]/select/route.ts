import { requireUserId, assertStopOwnedByUser, errorResponse } from '@/server/auth/guards';
import { selectStop } from '@/server/repos/stops';
import { rerouteLeg } from '@/server/repos/trips';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Promote a stop to status='selected' so it becomes a waypoint in the leg's
 * unified "Open in Google Maps" URL. Unlike routes, multiple stops may be
 * selected per leg (one waypoint each, ordered by distance_from_start_km or
 * sort_order).
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const id = parseUUID(params.id);
    if (!id) return Response.json({ error: 'Invalid stop id' }, { status: 400 });
    await assertStopOwnedByUser(id, userId);
    const result = await selectStop(id);
    if (!result) return Response.json({ error: 'Not found' }, { status: 404 });
    // Selecting a stop makes it a pass-through waypoint — bend the leg's stored
    // route through it so the map/distance/time match the handoff URL.
    await rerouteLeg(result.legId);
    return Response.json(result.stop);
  } catch (err) {
    return errorResponse(err);
  }
}
