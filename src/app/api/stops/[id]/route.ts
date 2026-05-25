import { z } from 'zod';
import {
  requireUserId,
  assertStopOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { deleteStop, getStop, updateStop } from '@/server/repos/stops';
import { rerouteLeg } from '@/server/repos/trips';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const stopTypeEnum = z.enum(['fuel', 'dump_station', 'food', 'overnight', 'rest', 'other']);
const stopStatusEnum = z.enum(['option', 'selected', 'dismissed']);
const fuelTypeEnum = z.enum(['diesel', 'petrol', 'premium', 'lpg']);
const stopSourceEnum = z.enum([
  'penny',
  'user',
  'google_places',
  'osm',
  'manual',
]);

const patchSchema = z.object({
  stop_type: stopTypeEnum.optional(),
  status: stopStatusEnum.optional(),
  name: z.string().min(1).optional(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  distance_from_start_km: z.number().nullish(),
  notes: z.string().nullish(),
  fuel_type: fuelTypeEnum.nullish(),
  fuel_amount_l: z.number().nullish(),
  source: stopSourceEnum.nullish(),
  source_url: z.string().nullish(),
  sort_order: z.number().int().optional(),
});

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const id = parseUUID(params.id);
    if (!id) return Response.json({ error: 'Invalid stop id' }, { status: 400 });
    await assertStopOwnedByUser(id, userId);
    const data = patchSchema.parse(await request.json());
    const stop = await updateStop(id, data);
    if (!stop) return Response.json({ error: 'Not found' }, { status: 404 });
    // Re-route the leg when a status flip or a moved/re-sorted selected waypoint
    // could change the routed path.
    const routingRelevant =
      data.status !== undefined ||
      data.lat !== undefined ||
      data.lng !== undefined ||
      data.distance_from_start_km !== undefined;
    if (routingRelevant && (data.status !== undefined || stop.status === 'selected')) {
      await rerouteLeg(stop.leg_id);
    }
    return Response.json(stop);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const id = parseUUID(params.id);
    if (!id) return Response.json({ error: 'Invalid stop id' }, { status: 400 });
    await assertStopOwnedByUser(id, userId);
    const doomed = await getStop(id);
    if (!doomed) return Response.json({ error: 'Not found' }, { status: 404 });
    await deleteStop(id);
    // If a pass-through waypoint was removed, re-route the leg without it.
    if (doomed.status === 'selected') {
      await rerouteLeg(doomed.leg_id);
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
