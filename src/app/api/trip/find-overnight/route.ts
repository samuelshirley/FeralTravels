import { z } from 'zod';
import {
  requireUserId,
  assertLegOwnedByUser,
  assertTripOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import {
  findOvernightSpots,
  bandSpotsByDriveTime,
  pickBestPerBand,
  type OvernightSpot,
} from '@/server/overnight/findOvernightSpots';
import { getLegTripId } from '@/server/repos/tasks';
import { db } from '@/server/db/client';
import { legs } from '@/server/db/schema';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Find overnight spots near a point. Two calling modes:
 *
 *   1. mode='leg'  — pass legId, we use the leg's start coords as the search
 *      origin and bin results into 3 drive-time bands (~3h / ~5h / ~6-7h).
 *      This is what Penny calls during planning and what the LegCard's
 *      "Find a spot near here" button uses.
 *
 *   2. mode='here' — pass lat/lng directly, returns flat sorted list. Used
 *      by the manual "I'm parked somewhere unexpected, find me a spot near
 *      here" finder on mobile.
 *
 * tripId is always required for ownership/quota — we wouldn't want anonymous
 * users hammering Google Places via this endpoint.
 */
const inputSchema = z
  .object({
    tripId: z.number().int().positive(),
    mode: z.enum(['leg', 'here']).default('leg'),
    legId: z.number().int().positive().optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    radiusKm: z.number().min(1).max(200).optional(),
    perSourceLimit: z.number().int().positive().max(100).optional(),
    bandsOnly: z.boolean().optional().default(false),
  })
  .refine(
    (v) =>
      (v.mode === 'leg' && v.legId != null) ||
      (v.mode === 'here' && v.lat != null && v.lng != null),
    { message: 'mode=leg requires legId; mode=here requires lat+lng' }
  );

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = inputSchema.parse(await req.json());

    await assertTripOwnedByUser(body.tripId, userId);

    let originLat: number;
    let originLng: number;
    if (body.mode === 'leg') {
      const legId = body.legId!;
      await assertLegOwnedByUser(legId, userId);
      const inferred = await getLegTripId(legId);
      if (inferred !== body.tripId) {
        return Response.json({ error: 'Leg does not belong to trip' }, { status: 400 });
      }
      const [leg] = await db
        .select({ startLat: legs.startLat, startLng: legs.startLng })
        .from(legs)
        .where(eq(legs.id, legId))
        .limit(1);
      if (!leg || leg.startLat == null || leg.startLng == null) {
        return Response.json(
          { error: 'Leg is missing start coordinates' },
          { status: 400 }
        );
      }
      originLat = leg.startLat;
      originLng = leg.startLng;
    } else {
      originLat = body.lat!;
      originLng = body.lng!;
    }

    // Default radius: large enough to catch ~6h of driving (≈420km at avg 70km/h),
    // but the cache key is the small grid bucket so re-queries near the same
    // origin are cheap.
    const radiusKm = body.radiusKm ?? (body.mode === 'leg' ? 420 : 60);

    const spots = await findOvernightSpots({
      lat: originLat,
      lng: originLng,
      radiusKm,
      perSourceLimit: body.perSourceLimit ?? 25,
      freeOnly: true,
    });

    if (body.mode === 'here') {
      // Tight radius — return everything sorted by distance.
      return Response.json({
        origin: { lat: originLat, lng: originLng },
        spots: spots.slice(0, 30),
      });
    }

    const banded = bandSpotsByDriveTime(spots, originLat, originLng);
    const best = pickBestPerBand(banded);
    return Response.json({
      origin: { lat: originLat, lng: originLng },
      candidates: best,
      banded: body.bandsOnly ? undefined : banded.slice(0, 30),
      raw: body.bandsOnly ? undefined : (spots.slice(0, 50) satisfies OvernightSpot[]),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
