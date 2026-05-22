import { z } from 'zod';
import { requireUserId, assertTripOwnedByUser, errorResponse } from '@/server/auth/guards';
import { updateTripPosition } from '@/server/repos/trips';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const tripId = parseUUID(ctx.params.id);
    if (!tripId) {
      return Response.json({ error: 'Invalid trip id' }, { status: 400 });
    }
    await assertTripOwnedByUser(tripId, userId);

    const body = bodySchema.parse(await req.json());
    await updateTripPosition(tripId, body.lat, body.lng);

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
