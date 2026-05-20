import { z } from 'zod';
import {
  requireUserId,
  assertTripReadableByUser,
  assertTripOwnedByUser,
  assertLegOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { getTasksForTrip, getTasksForLeg, addTask, getLegTripId } from '@/server/repos/tasks';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(request.url);
    const tripIdRaw = url.searchParams.get('tripId');
    const legIdRaw = url.searchParams.get('legId');

    if (legIdRaw) {
      const legId = parseUUID(legIdRaw);
      if (!legId) return Response.json({ error: 'legId must be a valid UUID' }, { status: 400 });
      const inferredTripId = tripIdRaw ? parseUUID(tripIdRaw) : await getLegTripId(legId);
      if (!inferredTripId) return Response.json({ error: 'Trip not found for leg' }, { status: 404 });
      await assertTripReadableByUser(inferredTripId, userId);
      return Response.json(await getTasksForLeg(legId));
    }

    if (!tripIdRaw) return Response.json({ error: 'tripId is required' }, { status: 400 });
    const tripId = parseUUID(tripIdRaw);
    if (!tripId) return Response.json({ error: 'tripId must be a valid UUID' }, { status: 400 });
    await assertTripReadableByUser(tripId, userId);
    return Response.json(await getTasksForTrip(tripId));
  } catch (err) {
    return errorResponse(err);
  }
}

const createSchema = z.object({
  tripId: z.string().uuid().optional(),
  trip_id: z.string().uuid().optional(),
  leg_id: z.string().uuid().nullish(),
  title: z.string().min(1),
  description: z.string().nullish(),
  priority: z.string().nullish(),
  status: z.string().nullish(),
  reference_url: z.string().nullish(),
  reference_label: z.string().nullish(),
  reference_phone: z.string().nullish(),
  created_by: z.string().nullish(),
  due_at: z.string().nullish(),
});

export async function POST(request: Request) {
  try {
    const userId = await requireUserId();
    const body = createSchema.parse(await request.json());

    let tripId: string | null = body.trip_id ?? body.tripId ?? null;
    const legId = body.leg_id ?? null;
    if (!tripId && legId) tripId = await getLegTripId(legId);
    if (!tripId) return Response.json({ error: 'tripId required' }, { status: 400 });

    await assertTripOwnedByUser(tripId, userId);
    if (legId) await assertLegOwnedByUser(legId, userId);

    const task = await addTask({
      trip_id: tripId,
      leg_id: legId,
      title: body.title,
      description: body.description ?? null,
      priority: body.priority ?? null,
      status: body.status ?? null,
      reference_url: body.reference_url ?? null,
      reference_label: body.reference_label ?? null,
      reference_phone: body.reference_phone ?? null,
      created_by: body.created_by ?? 'user',
      due_at: body.due_at ?? null,
    });
    return Response.json(task);
  } catch (err) {
    return errorResponse(err);
  }
}
