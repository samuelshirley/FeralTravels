import { z } from 'zod';
import {
  requireUserId,
  assertTripReadableByUser,
  assertLegOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { addStop, getStopsForLeg } from '@/server/repos/stops';
import { rerouteLeg } from '@/server/repos/trips';
import { getLegTripId } from '@/server/repos/tasks';
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

export async function GET(request: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(request.url);
    const legIdRaw = url.searchParams.get('legId');
    if (!legIdRaw) return Response.json({ error: 'legId is required' }, { status: 400 });
    const legId = parseUUID(legIdRaw);
    if (!legId)
      return Response.json({ error: 'legId must be a valid UUID' }, { status: 400 });
    const tripId = await getLegTripId(legId);
    if (!tripId) return Response.json({ error: 'Trip not found for leg' }, { status: 404 });
    await assertTripReadableByUser(tripId, userId);
    return Response.json(await getStopsForLeg(legId));
  } catch (err) {
    return errorResponse(err);
  }
}

const createSchema = z.object({
  leg_id: z.string().uuid(),
  stop_type: stopTypeEnum,
  name: z.string().min(1),
  status: stopStatusEnum.optional(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  distance_from_start_km: z.number().nullish(),
  notes: z.string().nullish(),
  fuel_type: fuelTypeEnum.nullish(),
  fuel_amount_l: z.number().nullish(),
  source: stopSourceEnum.nullish(),
  source_url: z.string().nullish(),
  sort_order: z.number().int().nullish(),
});

export async function POST(request: Request) {
  try {
    const userId = await requireUserId();
    const body = createSchema.parse(await request.json());
    await assertLegOwnedByUser(body.leg_id, userId);
    const stop = await addStop({
      leg_id: body.leg_id,
      stop_type: body.stop_type,
      name: body.name,
      status: body.status,
      lat: body.lat ?? null,
      lng: body.lng ?? null,
      distance_from_start_km: body.distance_from_start_km ?? null,
      notes: body.notes ?? null,
      fuel_type: body.fuel_type ?? null,
      fuel_amount_l: body.fuel_amount_l ?? null,
      source: body.source ?? null,
      source_url: body.source_url ?? null,
      sort_order: body.sort_order ?? null,
    });
    // A selected pass-through stop bends the leg's stored route, not just the
    // handoff URL.
    if (body.status === 'selected' && body.lat != null && body.lng != null) {
      await rerouteLeg(body.leg_id);
    }
    return Response.json(stop);
  } catch (err) {
    return errorResponse(err);
  }
}
