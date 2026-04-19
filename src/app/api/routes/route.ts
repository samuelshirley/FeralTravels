import { z } from 'zod';
import {
  requireUserId,
  assertTripReadableByUser,
  assertLegOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { getRoutesForLeg, addRoute } from '@/server/repos/routes';
import { getLegTripId } from '@/server/repos/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(request.url);
    const tripIdRaw = url.searchParams.get('tripId');
    const legIdRaw = url.searchParams.get('legId');
    if (!legIdRaw) return Response.json({ error: 'legId is required' }, { status: 400 });
    const legId = parseInt(legIdRaw, 10);
    if (Number.isNaN(legId)) return Response.json({ error: 'legId must be a number' }, { status: 400 });
    const inferredTripId = tripIdRaw ? parseInt(tripIdRaw, 10) : await getLegTripId(legId);
    if (!inferredTripId) return Response.json({ error: 'Trip not found for leg' }, { status: 404 });
    await assertTripReadableByUser(inferredTripId, userId);
    return Response.json(await getRoutesForLeg(legId));
  } catch (err) {
    return errorResponse(err);
  }
}

const createSchema = z.object({
  tripId: z.number().int().positive().optional(),
  leg_id: z.number().int().positive(),
  label: z.string().min(1),
  description: z.string().nullish(),
  distance_km: z.number().nullish(),
  surface: z.string().nullish(),
  status: z.string().nullish(),
  gpx_trail_id: z.number().int().positive().nullish(),
  sort_order: z.number().int().nullish(),
  links: z
    .array(
      z.object({
        url: z.string().url().or(z.string().min(1)),
        type: z.string().optional(),
        label: z.string().optional(),
      })
    )
    .optional(),
});

export async function POST(request: Request) {
  try {
    const userId = await requireUserId();
    const body = createSchema.parse(await request.json());
    await assertLegOwnedByUser(body.leg_id, userId);
    const route = await addRoute({
      leg_id: body.leg_id,
      label: body.label,
      description: body.description ?? null,
      distance_km: body.distance_km ?? null,
      surface: body.surface ?? null,
      status: body.status ?? null,
      gpx_trail_id: body.gpx_trail_id ?? null,
      sort_order: body.sort_order ?? null,
      links: body.links,
    });
    return Response.json(route);
  } catch (err) {
    return errorResponse(err);
  }
}
