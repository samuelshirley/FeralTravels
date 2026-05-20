import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  requireUserId,
  assertStopOwnedByUser,
  errorResponse,
  NotFoundError,
} from '@/server/auth/guards';
import { db } from '@/server/db/client';
import { stops, type StopAlternative } from '@/server/db/schema';
import { getStop } from '@/server/repos/stops';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  /** Index into the stop's `alternatives` array of the candidate to promote. */
  alt_index: z.number().int().min(0),
});

/**
 * POST /api/stops/:id/swap-primary
 *
 * Atomically swap a fuel/rest stop's primary fields with one of its
 * persisted alternates so the user can flip between Google Places
 * candidates without us re-querying Google. Lets the StopRow dropdown
 * change which station is the active waypoint in the leg's Maps URL.
 *
 * Behavior:
 *   - The current primary fields (name, lat, lng, source_url, distance — preserved)
 *     swap places with `alternatives[alt_index]`. The previous primary
 *     becomes the alternate at the same index.
 *   - `notes` is preserved (still says "Auto-suggested refuel ≈228 km…"),
 *     because the knot km doesn't change when we swap stations.
 *   - `status` is preserved. If the user had already marked the row
 *     'selected', the swap keeps it selected with the new station.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const id = parseUUID(params.id);
    if (!id) {
      return Response.json({ error: 'Invalid stop id' }, { status: 400 });
    }
    await assertStopOwnedByUser(id, userId);

    const body = bodySchema.parse(await req.json());

    const current = await getStop(id);
    if (!current) throw new NotFoundError('Stop not found');

    const alts: StopAlternative[] = (current.alternatives ?? []) as StopAlternative[];
    if (body.alt_index >= alts.length) {
      return Response.json(
        { error: `alt_index ${body.alt_index} out of range (have ${alts.length})` },
        { status: 400 }
      );
    }

    const promoted = alts[body.alt_index];
    if (current.lat == null || current.lng == null) {
      return Response.json(
        { error: 'Current stop has no coords to swap with' },
        { status: 400 }
      );
    }

    // Demote the current primary into the slot we just lifted from.
    const demoted: StopAlternative = {
      name: current.name,
      lat: current.lat,
      lng: current.lng,
      place_id: extractPlaceIdFromUrl(current.source_url),
      // distance_km on alternates is haversine-from-knot; we don't know
      // that for the previous primary at swap time. Keep what was already
      // there in the slot (close enough — the alternate's km becomes the
      // demoted's km, which the UI uses only for display).
      distance_km: promoted.distance_km,
    };

    const newAlts = alts.slice();
    newAlts[body.alt_index] = demoted;

    await db
      .update(stops)
      .set({
        name: promoted.name,
        lat: promoted.lat,
        lng: promoted.lng,
        sourceUrl: promoted.place_id
          ? `https://www.google.com/maps/place/?q=place_id:${promoted.place_id}`
          : null,
        alternatives: newAlts,
        updatedAt: new Date(),
      })
      .where(eq(stops.id, id));

    const updated = await getStop(id);
    if (!updated) throw new NotFoundError('Stop not found');
    return Response.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}

function extractPlaceIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/q=place_id:([^&]+)/);
  return m ? m[1] : null;
}
